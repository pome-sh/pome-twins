// SPDX-License-Identifier: Apache-2.0
//
// Black-box twin runtime-contract suite (FDRS-711). Spawns each BUILT twin
// exactly the way pome-cloud does (`node dist/src/server.js`, cwd = package
// root, TWIN_AUTH_SECRET/PORT injected) and asserts the control-plane surface
// documented in /CONTRACT.md from outside the process.
//
// These assertions FREEZE observed wire behavior — including per-twin
// divergences that are themselves under review (see FDRS-712). Changing any
// asserted status or shape is a contract change: update CONTRACT.md in the
// same PR and coordinate the cross-repo pome-cloud PR per the contract doc.
//
// Prerequisite: `bun run --filter '@pome-sh/shared-types' build:runtime` and
// `bun run --filter '@pome-sh/twin-*' build` (the root `test:contract` script
// chains all three).

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TWINS, mintSessionJwt, req, spawnTwin, spawnTwinRaw } from "./helpers.mjs";

const SID = "contract-sid";
const sPath = (p) => `/s/${SID}${p}`;

// Per-twin frozen expectations, taken from live probes on 2026-07-07.
const PER_TWIN = {
  github: {
    // /healthz carries fidelity + access_control on top of the shared core.
    healthzFidelity: "semantic",
    healthzExtras: ["access_control"],
    sessionHealthz: { status: 200 },
    // github validates seeds: a garbage body is a 422 GitHub validation error.
    adminSeedGarbage: { status: 422, check: (b) => b.message === "Validation Failed" },
    noAuth: { status: 401, check: (b) => b.message === "Bad credentials" },
    wrongSid: { status: 401, check: (b) => b.message === "Forbidden" },
    // hono/jwt's verify throws on an expired token before auth.ts's explicit
    // "Token expired" branch is reached, so the wire says "Bad credentials".
    expired: { status: 401, check: (b) => b.message === "Bad credentials" },
    rawToken: { status: 401 },
    mcpCallUnknown: { status: 422, check: (b) => b.message === "Validation Failed" },
    unknownSession: { status: 501, check: (b) => b._twin?.fidelity === "unsupported" },
    unknownRoot: { status: 404 },
  },
  slack: {
    // slack's /healthz carries no fidelity field today.
    healthzFidelity: undefined,
    sessionHealthz: { status: 200 },
    // slack accepts arbitrary seed bodies with 200 {ok:true} (no validation).
    adminSeedGarbage: { status: 200, check: (b) => b.ok === true },
    noAuth: { status: 401, check: (b) => b.ok === false && b.error === "not_authed" },
    wrongSid: { status: 401, check: (b) => b.error === "invalid_auth" },
    // slack is the only twin distinguishing token_expired from invalid_auth.
    expired: { status: 401, check: (b) => b.error === "token_expired" },
    rawToken: { status: 401 },
    mcpCallUnknown: { status: 404, check: (b) => b.error === "unknown_tool" },
    unknownSession: {
      status: 501,
      check: (b) => b.error === "unsupported_endpoint" && b._twin?.fidelity === "unsupported",
    },
    unknownRoot: { status: 404 },
  },
  stripe: {
    healthzFidelity: "semantic",
    healthzExtras: ["tthw_seconds"],
    // stripe has no per-session /healthz; the path falls to the 501 catch-all.
    sessionHealthz: { status: 501 },
    adminSeedGarbage: { status: 200, check: (b) => b.ok === true },
    noAuth: { status: 401, check: (b) => b.error?.code === "unauthorized" },
    // stripe is the only twin answering a sid mismatch with 403 (not 401).
    wrongSid: { status: 403, check: (b) => b.error?.code === "forbidden" },
    expired: { status: 401, check: (b) => b.error?.code === "unauthorized" },
    // stripe accepts a prefix-less bearer (raw JWT) today — FDRS-712 row 4.
    rawToken: { status: 200 },
    mcpCallUnknown: { status: 400, check: (b) => b.error?.code === "tool_unknown" },
    unknownSession: {
      status: 501,
      check: (b) => b.error?.code === "endpoint_not_supported" && b.error?.fidelity === "unsupported",
    },
    // stripe's root-level unknown paths hit the /v1 auth wall first: 401.
    unknownRoot: { status: 401 },
  },
};

function checkBody(expectation, body, label) {
  if (expectation.check) assert.ok(expectation.check(body ?? {}), `${label}: body shape — got ${JSON.stringify(body)}`);
}

for (const twin of TWINS) {
  const exp = PER_TWIN[twin.name];

  describe(`contract: ${twin.name}`, () => {
    let t;
    let jwt;

    before(async () => {
      t = await spawnTwin(twin); // asserts /healthz 200 within the 3s bound
      jwt = mintSessionJwt({ sid: SID });
    });
    after(async () => {
      await t?.close();
    });

    it("GET /healthz → 200 with the frozen shape (ok, twin, implementation, tools, runtime)", () => {
      const h = t.healthz;
      assert.equal(h.ok, true);
      assert.equal(h.twin, twin.name);
      assert.equal(typeof h.implementation, "string");
      assert.equal(typeof h.tools, "number");
      assert.ok(h.tools > 0, "advertises at least one MCP tool");
      if (exp.healthzFidelity !== undefined) assert.equal(h.fidelity, exp.healthzFidelity);
      for (const key of exp.healthzExtras ?? []) assert.ok(key in h, `healthz carries ${key}`);
      for (const key of ["package", "version", "git_sha", "build_time"]) {
        assert.equal(typeof h.runtime?.[key], "string", `runtime.${key} is a string`);
      }
    });

    it("POST /admin/reset from loopback → 200 {ok:true} (no bearer required)", async () => {
      const res = await req(t.base, "/admin/reset", { method: "POST" });
      assert.equal(res.status, 200);
      assert.equal(res.json?.ok, true);
    });

    it(`POST /admin/seed with a garbage body → ${exp.adminSeedGarbage.status} (frozen per-twin validation behavior)`, async () => {
      const res = await req(t.base, "/admin/seed", { method: "POST", body: { definitely: "not-a-seed" } });
      assert.equal(res.status, exp.adminSeedGarbage.status);
      checkBody(exp.adminSeedGarbage, res.json, "admin/seed garbage");
    });

    it("GET /s/:sid/_pome/health|state|events with a valid session JWT → 200", async () => {
      const health = await req(t.base, sPath("/_pome/health"), { token: jwt });
      assert.equal(health.status, 200);
      assert.equal(health.json?.ok, true);
      assert.equal(health.json?.twin, twin.name);

      const state = await req(t.base, sPath("/_pome/state"), { token: jwt });
      assert.equal(state.status, 200);
      assert.ok(state.json && typeof state.json === "object" && !Array.isArray(state.json), "state is a JSON object");

      const events = await req(t.base, sPath("/_pome/events"), { token: jwt });
      assert.equal(events.status, 200);
      assert.ok(Array.isArray(events.json), "events is a JSON array");
    });

    it(`GET /s/:sid/healthz → ${exp.sessionHealthz.status} (frozen; stripe has no per-session healthz)`, async () => {
      const res = await req(t.base, sPath("/healthz"), { token: jwt });
      assert.equal(res.status, exp.sessionHealthz.status);
      if (res.status === 200) {
        assert.equal(res.json?.ok, true);
        assert.equal(res.json?.sid, SID);
      }
    });

    it("MCP surface: tools list matches healthz.tools; JSON-RPC initialize 200; GET /mcp 405", async () => {
      const tools = await req(t.base, sPath("/mcp/tools"), { token: jwt });
      assert.equal(tools.status, 200);
      assert.ok(Array.isArray(tools.json?.tools));
      assert.equal(tools.json.tools.length, t.healthz.tools, "healthz.tools equals the MCP tool list length");

      const init = await req(t.base, sPath("/mcp"), {
        method: "POST",
        token: jwt,
        headers: { accept: "application/json, text/event-stream" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "contract-suite", version: "0" } },
        },
      });
      assert.equal(init.status, 200);
      assert.equal(init.json?.jsonrpc, "2.0");
      assert.equal(typeof init.json?.result?.serverInfo?.name, "string");

      const get = await req(t.base, sPath("/mcp"), { token: jwt });
      assert.equal(get.status, 405, "stateless-mode GET /mcp is 405");
    });

    it("POST /s/:sid/mcp/call with an unknown tool → frozen per-twin error envelope", async () => {
      const res = await req(t.base, sPath("/mcp/call"), {
        method: "POST",
        token: jwt,
        body: { tool: "definitely_not_a_tool", arguments: {} },
      });
      assert.equal(res.status, exp.mcpCallUnknown.status);
      checkBody(exp.mcpCallUnknown, res.json, "mcp/call unknown tool");
    });

    it("auth matrix: no token / garbage bearer / wrong-sid JWT / expired JWT / raw token", async () => {
      const noAuth = await req(t.base, sPath("/_pome/state"));
      assert.equal(noAuth.status, exp.noAuth.status);
      checkBody(exp.noAuth, noAuth.json, "no auth");

      const garbage = await req(t.base, sPath("/_pome/state"), { token: "garbage" });
      assert.equal(garbage.status, 401);

      const wrongSid = await req(t.base, sPath("/_pome/state"), { token: mintSessionJwt({ sid: "other-sid" }) });
      assert.equal(wrongSid.status, exp.wrongSid.status);
      checkBody(exp.wrongSid, wrongSid.json, "wrong sid");

      const expired = await req(t.base, sPath("/_pome/state"), { token: mintSessionJwt({ sid: SID, expSeconds: -60 }) });
      assert.equal(expired.status, exp.expired.status);
      checkBody(exp.expired, expired.json, "expired");

      const raw = await fetch(`${t.base}${sPath("/_pome/state")}`, {
        headers: { Authorization: mintSessionJwt({ sid: SID }) },
      });
      assert.equal(raw.status, exp.rawToken.status, "raw (prefix-less) bearer behavior is frozen per twin");
    });

    it("unknown session route → 501 unsupported envelope; unknown root route frozen", async () => {
      const unknown = await req(t.base, sPath("/definitely/not/a/route"), { token: jwt });
      assert.equal(unknown.status, exp.unknownSession.status);
      checkBody(exp.unknownSession, unknown.json, "unknown session route");

      const root = await req(t.base, "/definitely-not-a-route");
      assert.equal(root.status, exp.unknownRoot.status);
    });
  });
}

describe("contract: admin gate token mode + boot guards", () => {
  for (const twin of TWINS) {
    it(`${twin.name}: TWIN_ADMIN_TOKEN switches /admin/* to token auth (403 without/with-wrong header)`, async () => {
      const t = await spawnTwin(twin, { env: { TWIN_ADMIN_TOKEN: "contract-admin-token" } });
      try {
        const missing = await req(t.base, "/admin/reset", { method: "POST" });
        assert.equal(missing.status, 403);
        const wrong = await req(t.base, "/admin/reset", { method: "POST", headers: { "X-Admin-Token": "nope" } });
        assert.equal(wrong.status, 403);
        const right = await req(t.base, "/admin/reset", { method: "POST", headers: { "X-Admin-Token": "contract-admin-token" } });
        assert.equal(right.status, 200);
        assert.equal(right.json?.ok, true);
      } finally {
        await t.close();
      }
    });

    it(`${twin.name}: refuses to boot on a non-loopback host without TWIN_AUTH_SECRET`, async () => {
      const { code, output } = await spawnTwinRaw(twin, {
        [twin.hostEnv]: "0.0.0.0",
        PORT: "0",
        TWIN_AUTH_SECRET: "",
      });
      assert.notEqual(code, 0, "process exits non-zero");
      assert.match(output, /TWIN_AUTH_SECRET/, "error names the missing secret");
    });
  }
});
