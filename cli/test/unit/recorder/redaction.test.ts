// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { redactEvent } from "../../../src/recorder/redaction.js";

describe("redactEvent — hard-redacted header keys", () => {
  it("redacts Authorization (case-insensitive) to [REDACTED]", () => {
    const input = { headers: { Authorization: "Bearer test-key" } };
    expect(redactEvent(input)).toEqual({ headers: { Authorization: "[REDACTED]" } });
  });

  it("redacts lowercase authorization", () => {
    expect(redactEvent({ authorization: "Bearer abc" })).toEqual({ authorization: "[REDACTED]" });
  });

  it("redacts x-api-key (case-insensitive)", () => {
    expect(redactEvent({ "X-API-Key": "anything" })).toEqual({ "X-API-Key": "[REDACTED]" });
    expect(redactEvent({ "x-api-key": "anything" })).toEqual({ "x-api-key": "[REDACTED]" });
  });

  it("redacts cookie", () => {
    expect(redactEvent({ Cookie: "session=abc" })).toEqual({ Cookie: "[REDACTED]" });
    expect(redactEvent({ cookie: "session=abc" })).toEqual({ cookie: "[REDACTED]" });
  });

  it("redacts nested header objects", () => {
    const input = { req: { headers: { authorization: "Bearer x", "content-type": "application/json" } } };
    expect(redactEvent(input)).toEqual({
      req: { headers: { authorization: "[REDACTED]", "content-type": "application/json" } }
    });
  });
});

describe("redactEvent — regex scrubs in string values", () => {
  it("scrubs sk- API keys (20+ chars)", () => {
    const key = "sk-" + "abc123DEF456ghi789jklMNO";
    const out = redactEvent({ note: `key is ${key} and more` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("scrubs sk-ant- Anthropic prefix", () => {
    const key = "sk-" + "ant-api03-" + "A".repeat(20);
    const out = redactEvent({ note: `use ${key} tomorrow` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("scrubs GitHub PATs (ghp_<36>)", () => {
    const token = "ghp_" + "A".repeat(36);
    const out = redactEvent({ note: `token=${token} done` }) as { note: string };
    expect(out.note).not.toContain(token);
    expect(out.note).toContain("[REDACTED]");
  });

  it("scrubs AWS access keys (AKIA + 16 alnum)", () => {
    const key = "AKIA" + "ABCDEFGHIJ123456";
    const out = redactEvent({ note: `aws key ${key}!` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("scrubs JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactEvent({ token: jwt }) as { token: string };
    expect(out.token).not.toContain("eyJhbGciOi");
    expect(out.token).toBe("[REDACTED]");
  });

  it("scrubs PEM blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA...\n-----END RSA PRIVATE KEY-----";
    const out = redactEvent({ key: pem }) as { key: string };
    expect(out.key).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out.key).toContain("[REDACTED]");
  });

  it("scrubs secrets inside arrays", () => {
    const key = "sk-" + "abc123DEF456ghi789jklMN0";
    const out = redactEvent({ items: ["ok", key] }) as { items: string[] };
    expect(out.items[0]).toBe("ok");
    expect(out.items[1]).toContain("[REDACTED]");
    expect(out.items[1]).not.toContain(key);
  });
});

describe("redactEvent — provider secret shapes (FDRS-588 / FDRS-608)", () => {
  it("redacts the 12-char body Stripe seed key sk_test_pome_default", () => {
    const key = "sk_test_pome_default";
    const out = redactEvent({ note: `stripe secret ${key} here` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("redacts short Pome Stripe secret and restricted seed keys", () => {
    const secretKey = "sk_test_pome_a";
    const restrictedKey = "rk_test_pome_default";
    const out = redactEvent({ note: `${secretKey} ${restrictedKey}` }) as { note: string };
    expect(out.note).not.toContain(secretKey);
    expect(out.note).not.toContain(restrictedKey);
    expect(out.note).toBe("[REDACTED] [REDACTED]");
  });

  it("redacts live Stripe secret keys (sk_live_...)", () => {
    const key = "sk_live_" + "51H".repeat(8);
    const out = redactEvent({ note: `key=${key}` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("redacts Slack app-level tokens (xapp-...)", () => {
    const key = "xapp-1-A01B2C3D4E5-" + "1".repeat(20) + "-deadbeef";
    const out = redactEvent({ note: `token ${key}` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("redacts Google API keys (AIza...)", () => {
    const key = "AIza" + "SyD-abc123DEF456ghi789jklMNO_pqrstu";
    const out = redactEvent({ note: `google ${key}` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("fires inside nested tool_use / JSON shapes", () => {
    const stripeKey = "sk_test_pome_default";
    const input = {
      type: "tool_use",
      name: "create_charge",
      input: {
        args: { headers: { "x-stripe-key": stripeKey } },
        list: [{ deep: { note: `use ${stripeKey}` } }],
      },
    };
    const out = redactEvent(input) as typeof input;
    expect(JSON.stringify(out)).not.toContain(stripeKey);
    expect((out.input.args.headers as { "x-stripe-key": string })["x-stripe-key"]).toBe("[REDACTED]");
    expect(out.input.list[0].deep.note).toContain("[REDACTED]");
  });

  it("does not over-redact benign lookalikes", () => {
    // A task name that merely contains letters/underscores, no sk_test_/sk_live_ prefix.
    expect(redactEvent({ msg: "task_test_pipeline_default" })).toEqual({
      msg: "task_test_pipeline_default",
    });
    // "AIza" only redacts with a long body; a short word is untouched.
    expect(redactEvent({ msg: "AIza short" })).toEqual({ msg: "AIza short" });
    // A prose sentence with an apiVersion string stays intact.
    expect(redactEvent({ msg: "The sky is blue and skills matter." })).toEqual({
      msg: "The sky is blue and skills matter.",
    });
    // `sk-` redaction must not eat the "sk-" suffix inside ordinary slugs.
    expect(redactEvent({ msg: "task-management-service-endpoint-handler" })).toEqual({
      msg: "task-management-service-endpoint-handler",
    });
  });
});

// F-716 boundary pinning. These tests freeze the exact JWT / PEM scrub
// behavior of the pre-F-716 backtracking regexes: they were run green against
// the old patterns before the linear-time rewrite landed, and must stay green
// after. Any diff here is a redaction behavior change, not a refactor.
describe("redactEvent — F-716 JWT scrub boundary pinning", () => {
  it("redacts a JWT glued mid-base64url-run from the eyJ onward", () => {
    expect(redactEvent({ v: "AAAAeyJab.cd.ef" })).toEqual({ v: "AAAA[REDACTED]" });
  });

  it("redacts a dot-prefixed JWT, leaving the leading dot", () => {
    expect(redactEvent({ v: ".eyJab.cd.ef" })).toEqual({ v: ".[REDACTED]" });
  });

  it("consumes an embedded eyJ inside the header segment", () => {
    expect(redactEvent({ v: "eyJa.eyJb.c" })).toEqual({ v: "[REDACTED]" });
  });

  it("does not fire when the header segment is empty", () => {
    expect(redactEvent({ v: "eyJ..x" })).toEqual({ v: "eyJ..x" });
    expect(redactEvent({ v: "eyJ.a.b" })).toEqual({ v: "eyJ.a.b" });
  });

  it("does not fire on two-segment shapes", () => {
    expect(redactEvent({ v: "eyJab.cd" })).toEqual({ v: "eyJab.cd" });
  });

  it("consumes the trailing dot when the signature segment is empty", () => {
    expect(redactEvent({ v: "eyJa.b." })).toEqual({ v: "[REDACTED]" });
  });

  it("stops the signature segment at the first non-base64url char", () => {
    expect(redactEvent({ v: "eyJa.b.c.d" })).toEqual({ v: "[REDACTED].d" });
    expect(redactEvent({ v: "eyJa.b.ceyJ" })).toEqual({ v: "[REDACTED]" });
  });

  it("redacts multiple JWTs in one string", () => {
    expect(redactEvent({ v: "eyJa.b.c and eyJd.e.f" })).toEqual({
      v: "[REDACTED] and [REDACTED]",
    });
  });
});

describe("redactEvent — F-716 PEM scrub boundary pinning", () => {
  it("redacts a complete block as one unit", () => {
    expect(
      redactEvent({ v: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----" }),
    ).toEqual({ v: "[REDACTED]" });
  });

  it("redacts only the header of an unterminated block", () => {
    expect(redactEvent({ v: "-----BEGIN RSA PRIVATE KEY-----\nMIIB" })).toEqual({
      v: "[REDACTED]\nMIIB",
    });
  });

  it("redacts a nested block through the first valid END", () => {
    expect(
      redactEvent({ v: "-----BEGIN A-----\nx-----BEGIN B-----\ny\n-----END B-----\ntail" }),
    ).toEqual({ v: "[REDACTED]\ntail" });
  });

  it("leaves an END without a BEGIN untouched", () => {
    expect(redactEvent({ v: "data -----END A----- data" })).toEqual({
      v: "data -----END A----- data",
    });
  });

  it("ignores an END with an empty label, then redacts the dangling header", () => {
    expect(redactEvent({ v: "-----BEGIN A-----x-----END -----" })).toEqual({
      v: "[REDACTED]x-----END -----",
    });
  });

  it("consumes exactly five closing dashes", () => {
    expect(redactEvent({ v: "-----BEGIN A-----x-----END A------" })).toEqual({
      v: "[REDACTED]-",
    });
  });

  it("redacts a glued header whose closing dashes open the next header", () => {
    expect(redactEvent({ v: "-----BEGIN A-----BEGIN B-----" })).toEqual({
      v: "[REDACTED]BEGIN B-----",
    });
  });

  it("redacts two complete blocks separately", () => {
    expect(
      redactEvent({
        v: "-----BEGIN A-----x-----END A----- mid -----BEGIN B-----y-----END B-----",
      }),
    ).toEqual({ v: "[REDACTED] mid [REDACTED]" });
  });

  it("redacts a space-only label header", () => {
    expect(redactEvent({ v: "-----BEGIN  -----" })).toEqual({ v: "[REDACTED]" });
  });

  it("redacts a whole block whose body contains a JWT", () => {
    expect(redactEvent({ v: "-----BEGIN K-----\neyJa.b.c\n-----END K-----" })).toEqual({
      v: "[REDACTED]",
    });
  });
});

describe("redactEvent — F-716 differential fuzz vs the legacy patterns", () => {
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
      expect(redactEvent({ v: input })).toEqual({ v: legacyScrub(input) });
    }
  });
});

describe("redactEvent — benign content untouched", () => {
  it("leaves plain strings alone", () => {
    expect(redactEvent({ msg: "hello world" })).toEqual({ msg: "hello world" });
  });

  it("leaves numbers, booleans, and null alone", () => {
    expect(redactEvent({ n: 42, b: true, z: null })).toEqual({ n: 42, b: true, z: null });
  });

  it("does not scrub short sk- substrings (<20 chars)", () => {
    expect(redactEvent({ msg: "sk-short" })).toEqual({ msg: "sk-short" });
  });

  it("does not redact non-matching header-like keys", () => {
    expect(redactEvent({ "x-request-id": "req_abc" })).toEqual({ "x-request-id": "req_abc" });
  });
});
