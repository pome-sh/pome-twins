// SPDX-License-Identifier: Apache-2.0
//
// Coverage for the customisation hooks added in response to Gagan's
// PR #28 review: pluggable error envelope, catch-all 501 for unsupported
// surfaces, ok()/created() helpers, missing-admin.reset boot warning.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTwin } from "../src/index.js";
import { TwinError } from "../src/errors.js";
import { createApp, created, ok } from "../src/server.js";
import { recorderEventSchema } from "@pome-sh/shared-types";
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

const base = `/s/${TEST_SID}`;

// Suppress the admin.reset warning for tests that don't care about it.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("errorEnvelope override", () => {
  it("uses the manifest's projector for thrown errors (Stripe-shaped envelope)", async () => {
    const stripeShaped = defineTwin({
      id: "stripe-like",
      version: "0.1.0",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      errorEnvelope: (err) => {
        if (err instanceof TwinError) {
          return {
            status: err.status,
            body: {
              error: {
                type: "invalid_request_error",
                code: "invalid_field",
                message: err.message,
              },
            },
          };
        }
        return { status: 500, body: { error: { type: "api_error", message: "internal" } } };
      },
      routes: (app, { recorder }) => {
        app.post(
          "/v1/customers",
          recorder.handle({ mutation: true }, () => {
            throw new TwinError("email required", 400);
          })
        );
      },
      tools: [],
    });

    const app = createApp(stripeShaped);
    const res = await app.request(
      `${base}/v1/customers`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { type: "invalid_request_error", code: "invalid_field", message: "email required" },
    });
  });

  it("recorder still emits a valid recorder event with the custom body", async () => {
    const stripeShaped = defineTwin({
      id: "stripe-like-2",
      version: "0.1.0",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      errorEnvelope: (err) => ({
        status: err instanceof TwinError ? err.status : 500,
        body: { error: { message: err instanceof Error ? err.message : "unknown" } },
      }),
      routes: (app, { recorder }) => {
        app.post(
          "/v1/x",
          recorder.handle({ mutation: true }, () => {
            throw new TwinError("nope", 422);
          })
        );
      },
      tools: [],
    });

    const app = createApp(stripeShaped);
    await app.request(
      `${base}/v1/x`,
      withAuth(token, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
    );
    const events = (await (await app.request(`${base}/_pome/events`, withAuth(token))).json()) as Array<
      Record<string, unknown>
    >;
    const failed = events.find((e) => e.path === `${base}/v1/x`);
    expect(failed).toBeDefined();
    // Recording-spec validity preserved
    expect(recorderEventSchema.safeParse(failed).success).toBe(true);
    // Custom body recorded verbatim
    expect(failed?.response_body).toEqual({ error: { message: "nope" } });
    // Error string falls back to the thrown Error.message when the body lacks `.message` at root
    expect(failed?.error).toBe("nope");
    expect(failed?.state_mutation).toBe(false);
  });

  it("falls back to the generic envelope when manifest does not provide one", async () => {
    const generic = defineTwin({
      id: "generic-error",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      routes: (app, { recorder }) => {
        app.post(
          "/x",
          recorder.handle({ mutation: false }, () => {
            throw new TwinError("boom", 418);
          })
        );
      },
      tools: [],
    });
    const app = createApp(generic);
    const res = await app.request(
      `${base}/x`,
      withAuth(token, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
    );
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ message: "boom" });
  });
});

describe("catch-all for unsupported surfaces", () => {
  it("returns 501 with fidelity:'unsupported' for unmatched authenticated routes", async () => {
    const minimal = defineTwin({
      id: "no-routes",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    const app = createApp(minimal);

    const res = await app.request(`${base}/totally/unknown/path`, withAuth(token));
    expect(res.status).toBe(501);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      message: 'Endpoint not modeled by twin "no-routes".',
      fidelity: "unsupported",
      method: "GET",
      path: `${base}/totally/unknown/path`,
    });
  });

  it("records the unmatched request with fidelity:'unsupported' on the recorder", async () => {
    const minimal = defineTwin({
      id: "trace-unsupported",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    const app = createApp(minimal);

    await app.request(`${base}/missing/route`, withAuth(token));
    const events = (await (await app.request(`${base}/_pome/events`, withAuth(token))).json()) as Array<
      Record<string, unknown>
    >;
    const unsupported = events.find((e) => e.path === `${base}/missing/route`);
    expect(unsupported).toBeDefined();
    expect(unsupported).toMatchObject({
      status: 501,
      fidelity: "unsupported",
      state_mutation: false,
    });
    expect(unsupported?.error).toBe('Endpoint not modeled by twin "trace-unsupported".');
    expect(recorderEventSchema.safeParse(unsupported).success).toBe(true);
  });

  it("does not shadow user-registered routes", async () => {
    const withRoutes = defineTwin({
      id: "with-routes",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      routes: (app, { recorder }) => {
        app.get(
          "/v1/ping",
          recorder.handle({ mutation: false }, () => ok({ pong: true }))
        );
      },
      tools: [],
    });
    const app = createApp(withRoutes);
    const res = await app.request(`${base}/v1/ping`, withAuth(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it("returns 401 (not 501) for unauthenticated requests to unknown paths", async () => {
    const minimal = defineTwin({
      id: "auth-first",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    const app = createApp(minimal);
    const res = await app.request(`${base}/totally/unknown`);
    expect(res.status).toBe(401);
  });
});

describe("ok() and created() helpers", () => {
  it("ok() returns a 200 success result with the supplied mutation flag", () => {
    expect(ok({ a: 1 })).toEqual({ status: 200, body: { a: 1 }, mutation: false });
    expect(ok({ a: 1 }, true)).toEqual({ status: 200, body: { a: 1 }, mutation: true });
  });

  it("created() returns a 201 result with mutation:true", () => {
    expect(created({ id: "x" })).toEqual({ status: 201, body: { id: "x" }, mutation: true });
  });

  it("works as a recorder.handle inner-fn return value", async () => {
    const twin = defineTwin({
      id: "helpers",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      routes: (app, { recorder }) => {
        app.post(
          "/items",
          recorder.handle({ mutation: true }, () => created({ id: "new" }))
        );
        app.get(
          "/items",
          recorder.handle({ mutation: false }, () => ok({ items: [] }))
        );
      },
      tools: [],
    });
    const app = createApp(twin);
    const post = await app.request(
      `${base}/items`,
      withAuth(token, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
    );
    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({ id: "new" });
    const get = await app.request(`${base}/items`, withAuth(token));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ items: [] });
  });
});

describe("admin.reset boot warning", () => {
  it("warns when a twin ships without admin.reset", () => {
    warnSpy.mockClear();
    const minimal = defineTwin({
      id: "no-reset",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    createApp(minimal);
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("no-reset");
    expect(msg).toContain("admin.reset");
  });

  it("does not warn when admin.reset is configured", () => {
    warnSpy.mockClear();
    const withReset = defineTwin({
      id: "has-reset",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      admin: { reset: () => ({ ok: true }) },
      tools: [],
    });
    createApp(withReset);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// Manifest-meta validation for errorEnvelope: must be a function if provided.
describe("defineTwin meta-validation for errorEnvelope", () => {
  it("rejects non-function errorEnvelope", () => {
    expect(() =>
      defineTwin({
        id: "bad-envelope",
        version: "0.0.1",
        fidelity: { default: "semantic" },
        domain: () => ({}),
        // @ts-expect-error — must be a function
        errorEnvelope: { wrong: true },
        tools: [],
      })
    ).toThrow();
  });

  it("accepts a function errorEnvelope", () => {
    const def = defineTwin({
      id: "good-envelope",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      errorEnvelope: () => ({ status: 500, body: {} }),
      tools: [],
    });
    expect(def.errorEnvelope).toBeTypeOf("function");
  });
});

