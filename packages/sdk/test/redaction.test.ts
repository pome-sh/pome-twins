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
