// SPDX-License-Identifier: Apache-2.0
//
// Engine redaction tests (F-681). Redaction lives HERE, in the engine —
// per-twin recorders must not need their own copy for the tape to be safe
// (the §5.2 class of bug: one twin redacts, another doesn't).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createRecorderHandle, createRecorderStore } from "../src/recorder.js";
import { redactEvent, redactSecrets } from "../src/redaction.js";
import { defineTwin } from "../src/index.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;
beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

describe("redactSecrets", () => {
  it("replaces hard-redact keys regardless of value", () => {
    const out = redactSecrets({
      authorization: "Bearer abc",
      "x-api-key": "k",
      cookie: "session=1",
      token: "t",
      nested: { access_token: "a", safe: "keep" },
    }) as Record<string, unknown>;
    expect(out.authorization).toBe("[REDACTED]");
    expect(out["x-api-key"]).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).access_token).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).safe).toBe("keep");
  });

  it("matches hard-redact keys case-insensitively", () => {
    const out = redactSecrets({ Authorization: "Bearer abc" }) as Record<string, unknown>;
    expect(out.Authorization).toBe("[REDACTED]");
  });

  it("scrubs well-known credential shapes inside string values", () => {
    const ghp = `ghp_${"a".repeat(36)}`;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJ4In0.c2ln";
    const out = redactSecrets({
      note: `token ${ghp} embedded`,
      arr: [`sk-${"b".repeat(24)}`, "benign"],
      jwt,
      slack: `xoxb-${"c".repeat(24)}`,
      stripe: "sk_test_pome_abcd",
    }) as Record<string, unknown>;
    expect(out.note).toBe("token [REDACTED] embedded");
    expect((out.arr as string[])[0]).toBe("[REDACTED]");
    expect((out.arr as string[])[1]).toBe("benign");
    expect(out.jwt).toBe("[REDACTED]");
    expect(out.slack).toBe("[REDACTED]");
    expect(out.stripe).toBe("[REDACTED]");
  });

  it("scrubs PEM blocks", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe("[REDACTED]");
  });

  it("leaves non-secret scalars untouched", () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets("hello")).toBe("hello");
  });

  it("redactEvent is the event-write alias of redactSecrets", () => {
    const event = { response_body: { api_key: "secret" } };
    const out = redactEvent(event);
    expect((out.response_body as Record<string, unknown>).api_key).toBe("[REDACTED]");
  });
});

// F-716 boundary pinning. These tests freeze the exact JWT / PEM scrub
// behavior of the pre-F-716 backtracking regexes: they were run green against
// the old patterns before the linear-time rewrite landed, and must stay green
// after. Any diff here is a redaction behavior change, not a refactor.
describe("redactSecrets — F-716 JWT scrub boundary pinning", () => {
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

describe("redactSecrets — F-716 PEM scrub boundary pinning", () => {
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

describe("redactSecrets — F-716 differential fuzz vs the legacy patterns", () => {
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

describe("redactSecrets — F-716 adversarial inputs stay linear", () => {
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

// Slack-shape coverage lives HERE (F-683): the twin-slack package no longer
// carries a redaction mirror or its own copy of these assertions.
describe("slack token / webhook shapes", () => {
  it("scrubs bot and user session tokens (xoxb-/xoxp-)", () => {
    const bot = `xoxb-pome-${"a".repeat(24)}`;
    const user = `xoxp-pome-${"b".repeat(24)}`;
    expect(redactSecrets(`${bot} and ${user}`)).toBe("[REDACTED] and [REDACTED]");
  });

  it("scrubs Slack app-level tokens (xapp-...)", () => {
    const key = "xapp-1-A01B2C3D4E5-" + "1".repeat(20) + "-deadbeef";
    expect(redactSecrets(key)).toBe("[REDACTED]");
  });

  it("hard-redacts webhook_secret fields regardless of value", () => {
    const out = redactSecrets({ webhook_secret: "hooks.slack.com/services/T0/B0/x", name: "ok" }) as Record<
      string,
      unknown
    >;
    expect(out.webhook_secret).toBe("[REDACTED]");
    expect(out.name).toBe("ok");
  });

  it("fires inside nested twin request/response bodies", () => {
    const token = `xoxb-${"c".repeat(24)}`;
    const out = redactSecrets({
      type: "tool_use",
      input: { headers: { authorization: "Bearer x" }, body: `token=${token}` },
    });
    expect(JSON.stringify(out)).not.toContain(token);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  it("does not over-redact benign lookalikes", () => {
    expect(redactSecrets("The sky is blue and skills matter.")).toBe("The sky is blue and skills matter.");
    expect(redactSecrets({ msg: "xox-not-a-token" })).toEqual({ msg: "xox-not-a-token" });
  });
});

// GitHub-mirror coverage lives HERE (F-682): the twin-github package no
// longer carries a redaction mirror or its own copy of these assertions.
describe("github-mirror provider secret shapes", () => {
  it("redacts the 12-char body Stripe seed key sk_test_pome_default", () => {
    const key = "sk_test_pome_default";
    const out = redactSecrets({ note: `secret ${key}` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("redacts short Pome Stripe secret and restricted seed keys", () => {
    const secretKey = "sk_test_pome_a";
    const restrictedKey = "rk_test_pome_default";
    expect(redactSecrets(`${secretKey} ${restrictedKey}`)).toBe("[REDACTED] [REDACTED]");
  });

  it("redacts live Stripe secret keys", () => {
    const key = "sk_live_" + "51H".repeat(8);
    expect(redactSecrets(key)).toBe("[REDACTED]");
  });

  it("redacts Google API keys (AIza...)", () => {
    const key = "AIza" + "SyD-abc123DEF456ghi789jklMNO_pqrstu";
    expect(redactSecrets(key)).toBe("[REDACTED]");
  });

  it("does not over-redact benign lookalikes", () => {
    expect(redactSecrets({ msg: "task_test_pipeline_default" })).toEqual({
      msg: "task_test_pipeline_default",
    });
    expect(redactSecrets({ msg: "task-management-service-endpoint-handler" })).toEqual({
      msg: "task-management-service-endpoint-handler",
    });
  });
});

describe("recorder redacts every emitted event", () => {
  it("scrubs request_body and response_body at emit time", async () => {
    const store = createRecorderStore();
    const recorder = createRecorderHandle({ runId: "r", twin: "toy", store });
    const handler = recorder.handle({ mutation: false }, () => ({
      status: 200,
      body: { echo: `ghp_${"a".repeat(36)}`, api_key: "leak" },
    }));
    const { Hono } = await import("hono");
    const app = new Hono();
    app.post("/x", handler);
    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2", ok: "fine" }),
    });
    expect(res.status).toBe(200);
    // The HTTP response itself is NOT redacted — only the recorded tape.
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.api_key).toBe("leak");

    const [event] = store.events();
    expect(event).toBeDefined();
    const reqBody = event!.request_body as Record<string, unknown>;
    const resBody = event!.response_body as Record<string, unknown>;
    expect(reqBody.password).toBe("[REDACTED]");
    expect(reqBody.ok).toBe("fine");
    expect(resBody.api_key).toBe("[REDACTED]");
    expect(resBody.echo).toBe("[REDACTED]");
  });

  it("scrubs events recorded directly via recorder.record()", () => {
    const store = createRecorderStore();
    const recorder = createRecorderHandle({ runId: "r", twin: "toy", store });
    recorder.record({
      ts: new Date().toISOString(),
      run_id: "r",
      twin: "toy",
      request_id: "req_1",
      step_id: null,
      tool_call_id: null,
      method: "POST",
      path: "/x",
      request_body: { client_secret: "leak" },
      status: 200,
      response_body: null,
      latency_ms: 1,
      fidelity: "semantic",
      state_mutation: false,
      state_delta: null,
      error: null,
    });
    const [event] = store.events();
    expect((event!.request_body as Record<string, unknown>).client_secret).toBe("[REDACTED]");
  });
});

describe("/_pome/state is redacted centrally", () => {
  it("scrubs secrets from the state export without twin involvement", async () => {
    const leaky = defineTwin({
      id: "leaky",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      state: () => ({ webhook_secret: "leak", note: `xapp-${"d".repeat(16)}`, keep: "ok" }),
      tools: [],
    });
    const app = createApp(leaky);
    const res = await app.request(`/s/${TEST_SID}/_pome/state`, withAuth(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.webhook_secret).toBe("[REDACTED]");
    expect(body.note).toBe("[REDACTED]");
    expect(body.keep).toBe("ok");
  });
});
