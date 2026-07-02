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
