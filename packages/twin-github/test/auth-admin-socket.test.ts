// SPDX-License-Identifier: Apache-2.0
// FDRS-587: lock the admin gate's fail-CLOSED behavior over a REAL listening
// socket. The server is booted with @hono/node-server serve() on an ephemeral
// port — NOT app.request() and NOT a hand-built c.env.incoming mock — so the
// client IP flows through the runtime bridge exactly as it does in production.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { networkInterfaces } from "node:os";
import { createGitHubCloneApp } from "../src/app.js";

/** First non-internal IPv4 on this host, so requests to it arrive with a
 *  non-loopback peer address. GitHub CI runners always have one. */
function findExternalIPv4(): string | undefined {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return undefined;
}

const externalIp = findExternalIPv4();

let server: ServerType;
let port = 0;

beforeAll(async () => {
  const app = createGitHubCloneApp();
  await new Promise<void>((ready) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "0.0.0.0" }, (info) => {
      port = info.port;
      ready();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((done, fail) => {
    server.close((err) => (err ? fail(err) : done()));
  });
});

describe("admin gate over a real socket", () => {
  it("returns 200 for POST /admin/reset from a loopback client under NODE_ENV=production", async () => {
    // Run the loopback case in production mode: prod disables the
    // unknown-remote fail-open tier, so a 200 here proves the bridge really
    // resolved the peer address as loopback. Under the default test env a
    // silently broken getConnInfo integration (remote = undefined) would
    // fail-open to 200 and this assertion could not tell the difference.
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it.skipIf(!externalIp)(
    "returns 403 for POST /admin/reset from a non-loopback client (fail-closed)",
    async () => {
      const res = await fetch(`http://${externalIp}:${port}/admin/reset`, { method: "POST" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe("Forbidden");
    }
  );

  it.skipIf(!externalIp)(
    "with TWIN_ADMIN_TOKEN set, admits a non-loopback client only with the valid X-Admin-Token",
    async () => {
      process.env.TWIN_ADMIN_TOKEN = "socket-test-admin-token";
      try {
        const denied = await fetch(`http://${externalIp}:${port}/admin/reset`, {
          method: "POST",
          headers: { "X-Admin-Token": "wrong-token" },
        });
        expect(denied.status).toBe(403);

        const allowed = await fetch(`http://${externalIp}:${port}/admin/reset`, {
          method: "POST",
          headers: { "X-Admin-Token": "socket-test-admin-token" },
        });
        expect(allowed.status).toBe(200);
      } finally {
        delete process.env.TWIN_ADMIN_TOKEN;
      }
    }
  );
});
