import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  asBool,
  asNumber,
  asString,
  cursorDecode,
  cursorEncode,
  csvList,
  DETERMINISTIC_TS_BASE_SECONDS,
  normalizeTs,
  padTsCounter,
  parseFormOrJson,
  tsBaseSeconds,
} from "../src/util.js";

function captureApp(body: Record<string, unknown>[] = []) {
  const app = new Hono();
  app.post("/echo", async (c) => {
    const parsed = await parseFormOrJson(c);
    body.push(parsed);
    return c.json({ ok: true, parsed });
  });
  return { app, body };
}

describe("util helpers", () => {
  it("cursorEncode/decode round-trips offset", () => {
    const encoded = cursorEncode({ offset: 42 });
    expect(cursorDecode(encoded)).toEqual({ offset: 42 });
  });

  it("cursorDecode returns null for invalid cursor", () => {
    expect(cursorDecode("not-valid")).toBeNull();
    expect(cursorDecode(null)).toBeNull();
  });

  it("asBool coerces string truthiness", () => {
    expect(asBool("true")).toBe(true);
    expect(asBool("false")).toBe(false);
    expect(asBool("1")).toBe(true);
  });

  it("asNumber parses string numbers", () => {
    expect(asNumber("10", 0)).toBe(10);
    expect(asNumber("bad", 5)).toBe(5);
  });

  it("asString stringifies non-strings", () => {
    expect(asString(42)).toBe("42");
  });

  it("csvList splits comma-separated values", () => {
    expect(csvList("a, b ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("util edge cases", () => {
  it("cursorDecode rejects negative offsets", () => {
    const bad = cursorEncode({ offset: -1 });
    expect(cursorDecode(bad)).toBeNull();
  });

  it("cursorDecode rejects non-numeric offsets via tampered base64", () => {
    const tampered = Buffer.from(JSON.stringify({ offset: "not-a-number" }), "utf8").toString("base64url");
    expect(cursorDecode(tampered)).toBeNull();
  });

  it("cursorDecode rejects garbage base64", () => {
    expect(cursorDecode("@@@not-base64@@@")).toBeNull();
  });

  it("normalizeTs accepts valid Slack ts shape", () => {
    expect(normalizeTs("1735689600.000001")).toBe("1735689600.000001");
  });

  it("normalizeTs rejects non-strings and bad shapes", () => {
    expect(normalizeTs(123)).toBeUndefined();
    expect(normalizeTs("nope")).toBeUndefined();
    expect(normalizeTs("1234")).toBeUndefined();
  });

  it("tsBaseSeconds returns deterministic when env set", () => {
    process.env.SLACK_DETERMINISTIC_TS = "1";
    expect(tsBaseSeconds()).toBe(DETERMINISTIC_TS_BASE_SECONDS);
    delete process.env.SLACK_DETERMINISTIC_TS;
    const wall = tsBaseSeconds();
    expect(wall).toBeGreaterThan(DETERMINISTIC_TS_BASE_SECONDS);
    process.env.SLACK_DETERMINISTIC_TS = "1"; // restore for other tests
  });

  it("padTsCounter pads to 6 digits", () => {
    expect(padTsCounter(1)).toBe("000001");
    expect(padTsCounter(999999)).toBe("999999");
    expect(padTsCounter(1234567)).toBe("1234567"); // overflow not truncated
  });
});

describe("parseFormOrJson content-type strictness", () => {
  it("parses application/json bodies", async () => {
    const { app, body } = captureApp();
    await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", channel: "C_GENERAL" }),
    });
    expect(body[0]).toEqual({ text: "hi", channel: "C_GENERAL" });
  });

  it("parses form-encoded bodies", async () => {
    const { app, body } = captureApp();
    await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=hi&channel=C_GENERAL",
    });
    expect(body[0]).toEqual({ text: "hi", channel: "C_GENERAL" });
  });

  it("returns empty object for text/plain (no JSON smuggling)", async () => {
    const { app, body } = captureApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"is_admin": true, "evil": "payload"}',
    });
    expect(res.status).toBe(200);
    expect(body[0]).toEqual({});
  });

  it("returns empty object when content-type header is missing", async () => {
    const { app, body } = captureApp();
    const res = await app.request("/echo", {
      method: "POST",
      body: '{"text": "smuggled"}',
    });
    expect(res.status).toBe(200);
    expect(body[0]).toEqual({});
  });

  it("returns empty object for application/xml", async () => {
    const { app, body } = captureApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: "<root><text>hi</text></root>",
    });
    expect(res.status).toBe(200);
    expect(body[0]).toEqual({});
  });

  it("returns empty object for application/json with array body (Slack expects object root)", async () => {
    const { app, body } = captureApp();
    await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(body[0]).toEqual({});
  });

  it("returns empty object for malformed JSON", async () => {
    const { app, body } = captureApp();
    await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(body[0]).toEqual({});
  });

  it("returns empty object for malformed form-encoded body", async () => {
    const { app, body } = captureApp();
    // Hono's parseBody throws on malformed multipart; verify graceful empty return.
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----invalid" },
      body: "not-actually-multipart",
    });
    expect(res.status).toBe(200);
    expect(body[0]).toEqual({});
  });
});
