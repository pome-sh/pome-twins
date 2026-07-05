// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — anonymous demo mint: wire shape, group threading, honest
// capacity mapping.
import { describe, expect, it } from "vitest";
import { mintDemoSessions } from "../../../src/demo/mint.js";
import { DemoCapacityError } from "../../../src/demo/capacity.js";
import { HostedOrchError } from "../../../src/hosted/errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mintDemoSessions (FDRS-643)", () => {
  it("POSTs {task_name, task_hash:'', group_id} with NO auth header, once per trial, same group", async () => {
    const bodies: unknown[] = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://api.example.com/v1/demo/sessions");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-api-key")).toBeNull();
      bodies.push(JSON.parse(String(init?.body)));
      n += 1;
      return jsonResponse(201, {
        session_id: `ses_${n}`,
        demo_token: `jwt.${n}.sig`,
        expires_at: "2026-07-05T12:15:00.000Z",
      });
    };

    const sessions = await mintDemoSessions({
      apiBase: "https://api.example.com",
      taskName: "first-run-demo",
      groupId: "grp_abcdefghijklmnopqrstu",
      count: 5,
      fetchImpl,
    });

    expect(sessions).toHaveLength(5);
    expect(new Set(sessions.map((s) => s.session_id)).size).toBe(5);
    expect(bodies).toHaveLength(5);
    for (const body of bodies) {
      expect(body).toEqual({
        task_name: "first-run-demo",
        task_hash: "",
        group_id: "grp_abcdefghijklmnopqrstu",
      });
    }
  });

  it("maps a mint 429 (per-IP daily cap) to an honest DemoCapacityError", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(429, {
        error: {
          type: "rate_limited",
          message:
            "Daily demo limit reached for this network. Try again tomorrow, or sign up for a free account.",
        },
      });
    await expect(
      mintDemoSessions({
        apiBase: "https://api.example.com",
        taskName: "first-run-demo",
        groupId: "grp_abcdefghijklmnopqrstu",
        count: 5,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "DemoCapacityError",
      kind: "demo_ip_mint_cap",
      message: expect.stringContaining("Daily demo limit reached"),
    });
  });

  it("maps a mint 402 (house quota) to demo_mint_quota", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(402, {
        error: {
          type: "quota_exceeded",
          message: "The demo is at capacity right now. Try again shortly.",
        },
      });
    const err = await mintDemoSessions({
      apiBase: "https://api.example.com",
      taskName: "first-run-demo",
      groupId: "grp_abcdefghijklmnopqrstu",
      count: 1,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DemoCapacityError);
    expect((err as DemoCapacityError).kind).toBe("demo_mint_quota");
  });

  it("maps a mint 503 (demo not enabled) to gateway_unavailable with the cloud's message", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(503, {
        error: {
          type: "downstream_unavailable",
          message: "The anonymous demo is not enabled on this deployment.",
        },
      });
    const err = await mintDemoSessions({
      apiBase: "https://api.example.com",
      taskName: "first-run-demo",
      groupId: "grp_abcdefghijklmnopqrstu",
      count: 1,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DemoCapacityError);
    expect((err as DemoCapacityError).kind).toBe("gateway_unavailable");
    expect((err as DemoCapacityError).message).toContain("not enabled");
  });

  it("422 (unknown task) is an orch error, not a fabricated capacity state", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(422, {
        error: { type: "validation_failed", message: "Unknown demo task." },
      });
    const err = await mintDemoSessions({
      apiBase: "https://api.example.com",
      taskName: "nope",
      groupId: "grp_abcdefghijklmnopqrstu",
      count: 1,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedOrchError);
    expect((err as HostedOrchError).status).toBe(422);
  });

  it("rejects an unexpected 2xx shape instead of continuing with junk", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(201, { nope: true });
    await expect(
      mintDemoSessions({
        apiBase: "https://api.example.com",
        taskName: "first-run-demo",
        groupId: "grp_abcdefghijklmnopqrstu",
        count: 1,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(HostedOrchError);
  });
});
