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
