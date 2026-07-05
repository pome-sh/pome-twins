// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — hosted-client wire contract for trial groups:
//   - POST /v1/sessions carries `group_id` + `idempotency_key` when the
//     caller supplies them (shared-types 0.6.0 adds the field server-side;
//     an older cloud silently strips it, so sending is always safe);
//   - POST /v1/sessions/:id/abandon marks an errored trial failed NOW with a
//     short machine error_code (contract: pome-cloud routes/abandon.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedClient } from "../../../src/hosted/client.js";
import { HostedAuthError, HostedOrchError } from "../../../src/hosted/errors.js";

const BASE = "https://api.example.com";
const KEY = "pme_test_key";

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: typeof fetch) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl as never);
}

const SESSION_RESPONSE = JSON.stringify({
  session_id: "ses_abc",
  twin_url: "https://twins.example.com/s/ses_abc",
  expires_at: "2026-07-05T20:00:00Z",
  agent_token: "edt_jwt",
  openapi_url: "https://twins.example.com/s/ses_abc/openapi.json",
});

describe("HostedClient.createSession — group fields (FDRS-636)", () => {
  it("forwards group_id and idempotency_key on the mint body", async () => {
    mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.group_id).toBe("grp_useandom26T198340PX75");
      expect(body.idempotency_key).toBe("idem-1");
      return new Response(SESSION_RESPONSE, { status: 201 });
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.createSession({
      scenarioSource: "x",
      twins: ["github"],
      groupId: "grp_useandom26T198340PX75",
      idempotencyKey: "idem-1",
    });
    expect(out.session_id).toBe("ses_abc");
  });

  it("omits group_id entirely when not provided (k=1 stays exactly today's mint body)", async () => {
    mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("group_id");
      expect(body).not.toHaveProperty("idempotency_key");
      return new Response(SESSION_RESPONSE, { status: 201 });
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await client.createSession({ scenarioSource: "x", twins: ["github"] });
  });
});

describe("HostedClient.abandonSession (FDRS-636)", () => {
  it("POSTs {error_code} to /v1/sessions/:id/abandon with the same auth surface as finalize", async () => {
    mockFetch(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/v1/sessions/ses_abc/abandon`);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(KEY);
      expect(JSON.parse(String(init?.body))).toEqual({ error_code: "agent_timeout" });
      return new Response(
        JSON.stringify({
          session_id: "ses_abc",
          state: "failed",
          error_code: "agent_timeout",
          abandoned: true,
        }),
        { status: 200 },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.abandonSession("ses_abc", { errorCode: "agent_timeout" });
    expect(out.abandoned).toBe(true);
    expect(out.state).toBe("failed");
    expect(out.error_code).toBe("agent_timeout");
  });

  it("sends an empty body when no error code is known (contract allows it)", async () => {
    mockFetch(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({});
      return new Response(
        JSON.stringify({
          session_id: "ses_abc",
          state: "failed",
          error_code: null,
          abandoned: true,
        }),
        { status: 200 },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.abandonSession("ses_abc");
    expect(out.error_code).toBeNull();
  });

  it("an already-terminal session echoes its state with abandoned: false (idempotent no-op)", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          session_id: "ses_abc",
          state: "done",
          error_code: null,
          abandoned: false,
        }),
        { status: 200 },
      ),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.abandonSession("ses_abc", { errorCode: "agent_timeout" });
    expect(out.abandoned).toBe(false);
    expect(out.state).toBe("done");
  });

  it("throws HostedAuthError on 401 and HostedOrchError on the opaque 404", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { type: "invalid_auth", message: "bad key" } }), {
        status: 401,
      }),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(client.abandonSession("ses_abc")).rejects.toBeInstanceOf(HostedAuthError);

    mockFetch(async () =>
      new Response(JSON.stringify({ error: { type: "not_found", message: "Session not found." } }), {
        status: 404,
      }),
    );
    await expect(client.abandonSession("ses_gone")).rejects.toBeInstanceOf(HostedOrchError);
  });
});
