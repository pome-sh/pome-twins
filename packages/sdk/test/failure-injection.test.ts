// SPDX-License-Identifier: Apache-2.0
//
// Failure injection (FDRS-339), graduated from twin-stripe into the engine
// by the F-684 port ruling: the rule store + middleware are a generic twin
// capability (any twin can model "the provider failed on attempt N"), only
// the rule *payloads* (error envelopes) are twin-domain. Wire behavior is
// pinned by packages/twin-stripe/test/failure-injection.test.ts — this file
// covers the mechanism in isolation.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { RecorderEvent } from "@pome-sh/shared-types";
import {
  FAILURE_INJECTION_OVERRIDE_KEY,
  createFailureInjectionStore,
  failureInjectionMiddleware,
  failureInjectionRuleSchema,
  type FailureInjectionOverride,
} from "../src/failure-injection.js";

const RULE = {
  method: "post",
  path: "/v1/refunds",
  attempt: 1,
  mode: "before_handler",
  status: 402,
  body: { error: { type: "card_error", code: "card_declined", message: "Simulated failure." } },
} as const;

describe("failureInjectionRuleSchema", () => {
  it("uppercases the method and defaults mode to after_handler", () => {
    const parsed = failureInjectionRuleSchema.parse({
      method: "post",
      path: "/v1/refunds",
      attempt: 2,
      status: 500,
      body: {},
    });
    expect(parsed.method).toBe("POST");
    expect(parsed.mode).toBe("after_handler");
  });

  it("rejects non-positive attempts", () => {
    expect(() =>
      failureInjectionRuleSchema.parse({ method: "POST", path: "/x", attempt: 0, status: 500, body: {} })
    ).toThrow();
  });
});

describe("createFailureInjectionStore", () => {
  it("counts attempts per (account_id, method, path) tuple", () => {
    const store = createFailureInjectionStore();
    store.setRules([failureInjectionRuleSchema.parse({ ...RULE, attempt: 2 })]);
    // Non-matching tuples never bump the counter.
    expect(store.matchAndConsume("acct_a", "POST", "/v1/other")).toBeNull();
    expect(store.matchAndConsume("acct_a", "POST", "/v1/refunds")).toBeNull(); // attempt 1
    const hit = store.matchAndConsume("acct_a", "POST", "/v1/refunds"); // attempt 2
    expect(hit?.status).toBe(402);
    // Separate account has its own counter.
    expect(store.matchAndConsume("acct_b", "POST", "/v1/refunds")).toBeNull();
  });

  it("setRules resets counters; clear() empties everything", () => {
    const store = createFailureInjectionStore();
    store.setRules([failureInjectionRuleSchema.parse(RULE)]);
    expect(store.matchAndConsume("acct_a", "POST", "/v1/refunds")?.status).toBe(402);
    store.setRules([failureInjectionRuleSchema.parse(RULE)]);
    expect(store.matchAndConsume("acct_a", "POST", "/v1/refunds")?.status).toBe(402);
    store.clear();
    expect(store.matchAndConsume("acct_a", "POST", "/v1/refunds")).toBeNull();
  });
});

function buildApp(mode: "before_handler" | "after_handler", events: RecorderEvent[]) {
  const store = createFailureInjectionStore();
  store.setRules([failureInjectionRuleSchema.parse({ ...RULE, mode })]);
  const app = new Hono();
  let handlerRuns = 0;
  let overrideSeen: FailureInjectionOverride | undefined;
  // Simulate the engine's bearerAuth having resolved a session.
  app.use("*", async (c, next) => {
    c.set("session" as never, { sid: "s1", account_id: "acct_a" } as never);
    await next();
  });
  app.use(
    "*",
    failureInjectionMiddleware(store, {
      recorder: { record: (event) => events.push(event) },
      runId: "fi-test",
      twin: "stripe",
    })
  );
  app.post("/v1/refunds", (c) => {
    handlerRuns += 1;
    overrideSeen = c.get(FAILURE_INJECTION_OVERRIDE_KEY as never) as FailureInjectionOverride | undefined;
    return c.json({ object: "refund" });
  });
  return { app, runs: () => handlerRuns, override: () => overrideSeen };
}

describe("failureInjectionMiddleware", () => {
  it("before_handler: returns the envelope without invoking the handler and records the event", async () => {
    const events: RecorderEvent[] = [];
    const { app, runs } = buildApp("before_handler", events);
    const r1 = await app.request("/v1/refunds", { method: "POST", body: "{}" });
    const r2 = await app.request("/v1/refunds", { method: "POST", body: "{}" });
    expect(r1.status).toBe(402);
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe("card_declined");
    expect(r2.status).toBe(200);
    expect(runs()).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      twin: "stripe",
      run_id: "fi-test",
      method: "POST",
      path: "/v1/refunds",
      status: 402,
      state_mutation: false,
      state_delta: null,
    });
  });

  it("after_handler: lets the handler run and parks the override on the context", async () => {
    const events: RecorderEvent[] = [];
    const { app, runs, override } = buildApp("after_handler", events);
    const r1 = await app.request("/v1/refunds", { method: "POST", body: "{}" });
    // The middleware itself does not rewrite the response — the twin's
    // respond() applies the parked override (recorded + wire in one place).
    expect(r1.status).toBe(200);
    expect(runs()).toBe(1);
    expect(override()).toEqual({ status: 402, body: RULE.body });
    expect(events).toHaveLength(0);
  });

  it("matches the canonical path under the /s/:sid session mount", async () => {
    const events: RecorderEvent[] = [];
    const store = createFailureInjectionStore();
    store.setRules([failureInjectionRuleSchema.parse(RULE)]);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("session" as never, { sid: "s1", account_id: "acct_a" } as never);
      await next();
    });
    app.use("*", failureInjectionMiddleware(store, { recorder: { record: (e) => events.push(e) }, runId: "r", twin: "stripe" }));
    app.post("/s/:sid/v1/refunds", (c) => c.json({ object: "refund" }));
    const res = await app.request("/s/s1/v1/refunds", { method: "POST", body: "{}" });
    expect(res.status).toBe(402);
    // The recorded path is the raw wire path, not the stripped rule path.
    expect(events[0]?.path).toBe("/s/s1/v1/refunds");
  });

  it("passes through when no session is resolved (auth failure must not be shadowed)", async () => {
    const store = createFailureInjectionStore();
    store.setRules([failureInjectionRuleSchema.parse(RULE)]);
    const app = new Hono();
    app.use("*", failureInjectionMiddleware(store, { runId: "r", twin: "stripe" }));
    app.post("/v1/refunds", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/refunds", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
  });
});
