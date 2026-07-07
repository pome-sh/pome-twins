// SPDX-License-Identifier: Apache-2.0
// Co-located guard for the byte-identical redaction mirror (FDRS-588 / FDRS-608).
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redaction.js";

describe("redaction mirror — provider secret shapes", () => {
  it("redacts the 12-char body Stripe seed key sk_test_pome_default", () => {
    const key = "sk_test_pome_default";
    const out = redactSecrets({ note: `secret ${key}` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("redacts short Pome Stripe secret and restricted seed keys", () => {
    const secretKey = "sk_test_pome_a";
    const restrictedKey = "rk_test_pome_default";
    const out = redactSecrets(`${secretKey} ${restrictedKey}`) as string;
    expect(out).toBe("[REDACTED] [REDACTED]");
  });

  it("redacts live Stripe secret keys", () => {
    const key = "sk_live_" + "51H".repeat(8);
    const out = redactSecrets(key) as string;
    expect(out).toBe("[REDACTED]");
  });

  it("redacts Slack app-level tokens (xapp-...)", () => {
    const key = "xapp-1-A01B2C3D4E5-" + "1".repeat(20) + "-deadbeef";
    const out = redactSecrets(key) as string;
    expect(out).toBe("[REDACTED]");
  });

  it("redacts Google API keys (AIza...)", () => {
    const key = "AIza" + "SyD-abc123DEF456ghi789jklMNO_pqrstu";
    const out = redactSecrets(key) as string;
    expect(out).toBe("[REDACTED]");
  });

  it("fires inside nested tool_use / JSON shapes", () => {
    const key = "sk_test_pome_default";
    const out = redactSecrets({
      type: "tool_use",
      input: { headers: { authorization: "Bearer x" }, body: `k=${key}` },
    });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  it("does not over-redact benign lookalikes", () => {
    expect(redactSecrets({ msg: "task_test_pipeline_default" })).toEqual({
      msg: "task_test_pipeline_default",
    });
    expect(redactSecrets({ msg: "task-management-service-endpoint-handler" })).toEqual({
      msg: "task-management-service-endpoint-handler",
    });
    expect(redactSecrets("The sky is blue and skills matter.")).toBe(
      "The sky is blue and skills matter.",
    );
  });
});

// F-716 boundary pinning. These tests freeze the exact JWT / PEM scrub
// behavior of the pre-F-716 backtracking regexes: they were run green against
// the old patterns before the linear-time rewrite landed, and must stay green
// after. Any diff here is a redaction behavior change, not a refactor.
describe("redaction mirror — F-716 JWT scrub boundary pinning", () => {
  it("redacts a JWT glued mid-base64url-run from the eyJ onward", () => {
    expect(redactSecrets("AAAAeyJab.cd.ef")).toBe("AAAA[REDACTED]");
  });

  it("redacts a dot-prefixed JWT, leaving the leading dot", () => {
    expect(redactSecrets(".eyJab.cd.ef")).toBe(".[REDACTED]");
  });

  it("consumes an embedded eyJ inside the header segment", () => {
    expect(redactSecrets("eyJa.eyJb.c")).toBe("[REDACTED]");
  });

  it("does not fire when the header segment is empty", () => {
    expect(redactSecrets("eyJ..x")).toBe("eyJ..x");
    expect(redactSecrets("eyJ.a.b")).toBe("eyJ.a.b");
  });

  it("does not fire on two-segment shapes", () => {
    expect(redactSecrets("eyJab.cd")).toBe("eyJab.cd");
  });

  it("consumes the trailing dot when the signature segment is empty", () => {
    expect(redactSecrets("eyJa.b.")).toBe("[REDACTED]");
  });

  it("stops the signature segment at the first non-base64url char", () => {
    expect(redactSecrets("eyJa.b.c.d")).toBe("[REDACTED].d");
    expect(redactSecrets("eyJa.b.ceyJ")).toBe("[REDACTED]");
  });

  it("redacts multiple JWTs in one string", () => {
    expect(redactSecrets("eyJa.b.c and eyJd.e.f")).toBe("[REDACTED] and [REDACTED]");
  });
});

describe("redaction mirror — F-716 PEM scrub boundary pinning", () => {
  it("redacts a complete block as one unit", () => {
    expect(redactSecrets("-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----")).toBe(
      "[REDACTED]",
    );
  });

  it("redacts only the header of an unterminated block", () => {
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIB")).toBe("[REDACTED]\nMIIB");
  });

  it("redacts a nested block through the first valid END", () => {
    expect(redactSecrets("-----BEGIN A-----\nx-----BEGIN B-----\ny\n-----END B-----\ntail")).toBe(
      "[REDACTED]\ntail",
    );
  });

  it("leaves an END without a BEGIN untouched", () => {
    expect(redactSecrets("data -----END A----- data")).toBe("data -----END A----- data");
  });

  it("ignores an END with an empty label, then redacts the dangling header", () => {
    expect(redactSecrets("-----BEGIN A-----x-----END -----")).toBe("[REDACTED]x-----END -----");
  });

  it("consumes exactly five closing dashes", () => {
    expect(redactSecrets("-----BEGIN A-----x-----END A------")).toBe("[REDACTED]-");
  });

  it("redacts a glued header whose closing dashes open the next header", () => {
    expect(redactSecrets("-----BEGIN A-----BEGIN B-----")).toBe("[REDACTED]BEGIN B-----");
  });

  it("redacts two complete blocks separately", () => {
    expect(
      redactSecrets("-----BEGIN A-----x-----END A----- mid -----BEGIN B-----y-----END B-----"),
    ).toBe("[REDACTED] mid [REDACTED]");
  });

  it("redacts a space-only label header", () => {
    expect(redactSecrets("-----BEGIN  -----")).toBe("[REDACTED]");
  });

  it("redacts a whole block whose body contains a JWT", () => {
    expect(redactSecrets("-----BEGIN K-----\neyJa.b.c\n-----END K-----")).toBe("[REDACTED]");
  });
});

describe("redaction mirror — F-716 differential fuzz vs the legacy patterns", () => {
  // The exact pre-F-716 scrub pipeline, kept verbatim as the behavior oracle.
  // Only run on short fuzz strings, where its quadratic worst case is harmless.
  const LEGACY_SCRUB_PATTERNS: RegExp[] = [
    /redaction_fixture_secret_[A-Za-z0-9_-]{8,}/g,
    /\bsk-[A-Za-z0-9_-]{20,}/g,
    /\b[rs]k_(?:test|live)_[A-Za-z0-9_]{4,}/g,
    /ghp_[A-Za-z0-9]{36}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /xox[aboprs]-[A-Za-z0-9-]{20,}/g,
    /xapp-[A-Za-z0-9-]{10,}/g,
    /(?:pme|pk|rk)_[A-Za-z0-9_-]{20,}/g,
    /AIza[0-9A-Za-z_-]{20,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    /-----BEGIN [A-Z ]+-----/g,
  ];

  function legacyScrub(value: string): string {
    let out = value;
    for (const pattern of LEGACY_SCRUB_PATTERNS) {
      out = out.replace(pattern, "[REDACTED]");
    }
    return out;
  }

  const PIECES = [
    "eyJ",
    ".",
    "a",
    "B9",
    "_",
    "-",
    " ",
    "\n",
    "-----BEGIN ",
    "-----END ",
    "-----",
    "AB C",
    "!",
    "ey",
    "J",
  ];

  it("matches the legacy scrub on 2000 seeded fuzz strings", () => {
    let seed = 0xf716;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 2000; round += 1) {
      const parts: string[] = [];
      const length = next() % 24;
      for (let p = 0; p < length; p += 1) parts.push(PIECES[next() % PIECES.length]!);
      const input = parts.join("");
      expect(redactSecrets(input)).toBe(legacyScrub(input));
    }
  });
});

describe("redaction mirror — F-716 adversarial inputs stay linear", () => {
  // Both inputs drive the pre-F-716 regexes into quadratic backtracking
  // (minutes of CPU); the linear scanners handle them in milliseconds. The
  // 1s bound leaves two orders of magnitude of CI headroom.
  it("survives a 150 KB dotless eyJ run", () => {
    const input = "eyJ".repeat(50_000);
    const started = performance.now();
    expect(redactSecrets(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("survives 20k unterminated PEM headers", () => {
    const input = "-----BEGIN AAAA-----\n".repeat(20_000);
    const started = performance.now();
    expect(redactSecrets(input)).toBe("[REDACTED]\n".repeat(20_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
