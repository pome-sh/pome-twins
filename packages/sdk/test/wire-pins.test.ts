// SPDX-License-Identifier: Apache-2.0
//
// Engine pins from the F-683 M1 review: per-twin body readers, the
// session-middleware slot, legacy /mcp/call alias keys, the pomeHealth
// extras hook, the admin error envelope, the unrecorded /_pome/state
// export, bounded recorder stores, and mint/verify exp symmetry.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Context } from "hono";
import { defineTwin } from "../src/index.js";
import { createApp, createRecorderStore, mintProviderToken } from "../src/server.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken } from "./_authHelper.js";

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

const sPath = (p: string) => `/s/${TEST_SID}${p}`;
const auth = () => ({ authorization: `Bearer ${token}` });

interface ToyDomain {
  seeded: unknown[];
}

function toyTwin(overrides: Record<string, unknown> = {}) {
  return defineTwin<unknown, Record<string, unknown>, ToyDomain>({
    id: "toy",
    version: "0.0.0",
    fidelity: { default: "semantic" },
    seed: z.record(z.string(), z.unknown()),
    domain: () => ({ seeded: [] }),
    state: ({ domain }: { domain: ToyDomain }) => ({ seeded: domain.seeded.length }),
    admin: {
      reset: () => ({ ok: true }),
      seed: ({ domain, seed }: { domain: ToyDomain; seed: unknown }) => {
        domain.seeded.push(seed);
        return { ok: true };
      },
    },
    tools: [
      {
        name: "echo",
        description: "echo",
        schema: z.object({ value: z.string().default("none") }),
        mutation: false,
        handler: (_domain: ToyDomain, args: unknown) => ({ echoed: (args as { value: string }).value }),
      },
    ],
    ...overrides,
  } as never);
}

describe("bodyReader — per-twin body parsing on engine-owned surfaces", () => {
  const formTolerant = async (c: Context): Promise<unknown> => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/x-www-form-urlencoded")) return c.req.parseBody();
    try {
      return await c.req.json();
    } catch {
      return {};
    }
  };

  it("default reader keeps strict JSON: malformed seed surfaces through the envelope", async () => {
    const app = createApp(toyTwin());
    const res = await app.request("/admin/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(res.status).toBe(400); // engine default envelope maps SyntaxError → 400
  });

  it("a declared reader feeds /admin/seed and legacy /mcp/call (form + malformed)", async () => {
    const app = createApp(toyTwin({ bodyReader: formTolerant }));
    const seeded = await app.request("/admin/seed", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "flavor=plum",
    });
    expect(seeded.status).toBe(200);

    const call = await app.request(sPath("/mcp/call"), {
      method: "POST",
      headers: { ...auth(), "content-type": "application/x-www-form-urlencoded" },
      body: "tool=echo",
    });
    expect(call.status).toBe(200);
    expect(await call.json()).toEqual({ echoed: "none" });
  });
});

describe("legacyMcp — frozen alias keys and missing-tool envelope", () => {
  const twin = () =>
    toyTwin({
      legacyMcp: {
        aliases: true,
        missingTool: () => ({ status: 400, body: { ok: false, error: "invalid_arguments" } }),
      },
    });

  it("dispatches {name}/{params} as {tool}/{arguments}", async () => {
    const app = createApp(twin());
    const res = await app.request(sPath("/mcp/call"), {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ name: "echo", params: { value: "aliased" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: "aliased" });
  });

  it("a body naming no tool answers the twin's missingTool envelope", async () => {
    const app = createApp(twin());
    const res = await app.request(sPath("/mcp/call"), {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_arguments" });
  });

  it("without aliases the strict schema still governs", async () => {
    const app = createApp(toyTwin());
    const res = await app.request(sPath("/mcp/call"), {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ name: "echo" }),
    });
    expect(res.status).not.toBe(200);
  });
});

describe("middleware — the pre-port session.use('*') slot covers MCP dispatch", () => {
  it("runs for legacy /mcp/call and can short-circuit it", async () => {
    const seen: string[] = [];
    const app = createApp(
      toyTwin({
        middleware: (session: { use: Function }) => {
          session.use("*", async (c: Context, next: () => Promise<void>) => {
            seen.push(new URL(c.req.url).pathname);
            if (c.req.header("x-inject") === "boom") return c.json({ injected: true }, 502);
            await next();
          });
        },
      })
    );
    const injected = await app.request(sPath("/mcp/call"), {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "x-inject": "boom" },
      body: JSON.stringify({ tool: "echo", arguments: {} }),
    });
    expect(injected.status).toBe(502);
    const normal = await app.request(sPath("/mcp/call"), {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ tool: "echo", arguments: {} }),
    });
    expect(normal.status).toBe(200);
    expect(seen.length).toBe(2);
  });
});

describe("pomeHealth — frozen /_pome/health shapes", () => {
  it("defaults to {ok, twin, version, fidelity}", async () => {
    const app = createApp(toyTwin());
    const res = await app.request(sPath("/_pome/health"), { headers: auth() });
    expect(Object.keys((await res.json()) as Record<string, unknown>).sort()).toEqual(["fidelity", "ok", "twin", "version"]);
  });

  it("a twin with extras() => ({}) pins the bare {ok, twin} shape", async () => {
    const app = createApp(toyTwin({ pomeHealth: () => ({}) }));
    const res = await app.request(sPath("/_pome/health"), { headers: auth() });
    expect(Object.keys((await res.json()) as Record<string, unknown>).sort()).toEqual(["ok", "twin"]);
  });
});

describe("/_pome/state is never recorded on the tape", () => {
  it("a state fetch adds no recorder event", async () => {
    const store = createRecorderStore();
    const app = createApp(toyTwin(), { recorder: store });
    const res = await app.request(sPath("/_pome/state"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(store.events().some((e) => String(e.path).includes("_pome/state"))).toBe(false);
  });
});

describe("admin.errorEnvelope — per-surface projection", () => {
  it("admin errors bypass the session envelope when declared", async () => {
    const app = createApp(
      toyTwin({
        seed: z.object({ must: z.string() }),
        errorEnvelope: () => ({ status: 200, body: { ok: false } }),
        admin: {
          reset: () => ({ ok: true }),
          seed: () => ({ ok: true }),
          errorEnvelope: (err: unknown) => ({
            status: 500,
            body: { ok: false, error: "internal_error", warning: err instanceof Error ? err.message : "x" },
          }),
        },
      })
    );
    const res = await app.request("/admin/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: "shape" }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("internal_error");
  });
});

describe("bounded recorder store", () => {
  it("caps at maxEvents, drops oldest, counts drops", () => {
    const store = createRecorderStore({ maxEvents: 2 });
    const ev = (id: string) => ({ request_id: id }) as never;
    store.record(ev("a"));
    store.record(ev("b"));
    store.record(ev("c"));
    expect(store.events().map((e) => (e as { request_id: string }).request_id)).toEqual(["b", "c"]);
    expect(store.dropped?.()).toBe(1);
    expect(store.count?.()).toBe(2);
  });

  it("default store is unbounded with zero drops", () => {
    const store = createRecorderStore();
    for (let i = 0; i < 5; i += 1) store.record({ request_id: String(i) } as never);
    expect(store.count?.()).toBe(5);
    expect(store.dropped?.()).toBe(0);
  });
});

describe("mintProviderToken exp validation", () => {
  const spec = { provider: "toy", prefixes: ["toy-"] };

  it("throws on a millisecond-scale exp instead of minting an unverifiable token", () => {
    expect(() => mintProviderToken(spec, { sid: "s", exp: Date.now(), secret: "k" })).toThrow(/milliseconds/);
  });

  it("throws on a non-integer exp instead of silently minting a never-expiring token", () => {
    expect(() => mintProviderToken(spec, { sid: "s", exp: 1.5, secret: "k" })).toThrow(/positive integer/);
  });

  it("still mints the legacy shape when exp is omitted", () => {
    expect(mintProviderToken(spec, { sid: "s", secret: "k" })).toMatch(/^toy-/);
  });
});
