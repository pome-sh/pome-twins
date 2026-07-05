// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTwin } from "../src/index.js";
import { createApp, TwinBootError } from "../src/server.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";
import { toyTwin } from "./_toyTwin.js";

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

// Silence the admin.reset boot warning — tests that exercise the warning
// itself live in customizations.test.ts.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

const base = `/s/${TEST_SID}`;

describe("createApp boot guards", () => {
  it("auto-mounts /healthz at root with no auth", async () => {
    const app = createApp(toyTwin);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      twin: "toy",
      version: "0.1.0",
      fidelity: "semantic",
      tools: 2,
    });
  });

  it("auto-mounts /s/:sid/_pome/{health,state,events} under bearer auth", async () => {
    const app = createApp(toyTwin, { seed: { items: ["a", "b"] } });

    expect((await app.request(`${base}/_pome/health`)).status).toBe(401);

    const health = await app.request(`${base}/_pome/health`, withAuth(token));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, twin: "toy" });

    const state = await app.request(`${base}/_pome/state`, withAuth(token));
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ items: ["a", "b"] });

    const events = await app.request(`${base}/_pome/events`, withAuth(token));
    expect(events.status).toBe(200);
    const list = (await events.json()) as unknown[];
    expect(Array.isArray(list)).toBe(true);
  });

  it("returns 501 from /_pome/state when twin has no `state` configured", async () => {
    const noState = defineTwin({
      id: "no-state",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    const app = createApp(noState);
    const res = await app.request(`${base}/_pome/state`, withAuth(token));
    expect(res.status).toBe(501);
  });

  it("auto-mounts /admin/{reset,seed} behind requireAdminAuth", async () => {
    const app = createApp(toyTwin, { seed: { items: ["x"] } });

    const reset = await app.request("/admin/reset", { method: "POST" });
    expect(reset.status).toBe(200);

    const seedRes = await app.request("/admin/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: ["fresh"] }),
    });
    expect(seedRes.status).toBe(200);

    const state = await app.request(`${base}/_pome/state`, withAuth(token));
    expect(await state.json()).toEqual({ items: ["fresh"] });
  });

  it("returns 501 from /admin/* when twin has no admin handlers", async () => {
    const noAdmin = defineTwin({
      id: "no-admin",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    const app = createApp(noAdmin);
    const reset = await app.request("/admin/reset", { method: "POST" });
    expect(reset.status).toBe(501);
  });

  it("refuses to boot if user routes shadow /_pome/*", () => {
    const shadowing = defineTwin({
      id: "shadow",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      routes: (app, { recorder }) => {
        app.get(
          "/_pome/state",
          recorder.handle({ mutation: false }, () => ({ status: 200, body: {} }))
        );
      },
      tools: [],
    });
    expect(() => createApp(shadowing)).toThrow(TwinBootError);
    expect(() => createApp(shadowing)).toThrow(/_pome/);
  });

  it("refuses to boot if user routes shadow /mcp/*", () => {
    const shadowing = defineTwin({
      id: "shadow-mcp",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      routes: (app, { recorder }) => {
        app.get(
          "/mcp/tools",
          recorder.handle({ mutation: false }, () => ({ status: 200, body: {} }))
        );
      },
      tools: [],
    });
    expect(() => createApp(shadowing)).toThrow(TwinBootError);
  });

  it("validates seed against the manifest seed schema", () => {
    expect(() =>
      createApp(toyTwin, {
        // @ts-expect-error — items must be string[]
        seed: { items: [42] },
      })
    ).toThrow(z.ZodError);
  });

  it("mounts user routes under /s/:sid/*", async () => {
    const app = createApp(toyTwin, { seed: { items: ["seed"] } });

    const list = await app.request(`${base}/items`, withAuth(token));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: ["seed"] });

    const add = await app.request(
      `${base}/items`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: "new" }),
      })
    );
    expect(add.status).toBe(201);
    expect(await add.json()).toMatchObject({ item: "new", total: 2 });
  });
});
