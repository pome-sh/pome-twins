// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — the hosted client's bearer scheme: `pome demo` authenticates
// upload-url + finalize with the trial's demo_token as `Authorization:
// Bearer …` (the requireApiKeyOrSessionToken surface), never X-API-KEY.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedClient } from "../../../src/hosted/client.js";
import { HostedQuotaError } from "../../../src/hosted/errors.js";

const BASE = "https://api.example.com";
const DEMO_TOKEN = "aaa.bbb.ccc";

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: typeof fetch) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl as never);
}

describe("createHostedClient authScheme: bearer (FDRS-643)", () => {
  it("sends Authorization: Bearer on finalize with the explicit 60s demo timeout config", async () => {
    mockFetch(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/v1/sessions/ses_1/finalize`);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${DEMO_TOKEN}`);
      expect(headers.get("x-api-key")).toBeNull();
      return new Response(
        JSON.stringify({
          run_id: "run_1",
          score: 100,
          judge_model: "m",
          dashboard_url: "https://app.example.com/runs/run_1",
          criteria_results: [],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const client = createHostedClient({
      baseUrl: BASE,
      apiKey: DEMO_TOKEN,
      authScheme: "bearer",
      timeoutMs: 60_000,
    });
    const out = await client.finalize("ses_1", {
      stopReason: "completed",
      exitCode: 0,
      durationMs: 1000,
      agentModel: "demo-gateway",
      criteria: [],
      scenarioName: "first-run-demo",
      scenarioHash: "",
      scenarioPrompt: "",
      expectedBehavior: "",
    });
    expect(out.run_id).toBe("run_1");
  });

  it("sends Authorization: Bearer on the presigned-upload routes", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${DEMO_TOKEN}`);
      expect(headers.get("x-api-key")).toBeNull();
      if (String(url).endsWith("/result-upload-url")) {
        return new Response(
          JSON.stringify({ url: "https://blobs.example.com/e", key: "team-t/session-s/events.jsonl" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          state_initial: { url: "https://blobs.example.com/i", key: "team-t/session-s/state_initial.json" },
          state_final: { url: "https://blobs.example.com/f", key: "team-t/session-s/state_final.json" },
        }),
        { status: 200 },
      );
    });

    const client = createHostedClient({
      baseUrl: BASE,
      apiKey: DEMO_TOKEN,
      authScheme: "bearer",
    });
    await client.requestEventsUploadUrl("ses_1");
    await client.requestStateUploadUrl("ses_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the X-API-KEY contract byte-for-byte when authScheme is omitted", async () => {
    mockFetch(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("pme_key");
      expect(headers.get("authorization")).toBeNull();
      return new Response(JSON.stringify({ url: "u", key: "k" }), { status: 200 });
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: "pme_key" });
    await client.requestEventsUploadUrl("ses_1");
  });

  it("surfaces machine-readable quota details for honest at-capacity rendering", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "quota_exceeded",
            message: "Daily managed-judge spend cap reached for this team.",
            details: { kind: "daily_judge_cap", spent_cents: 500, cap_cents: 500 },
            request_id: "req_9",
          },
        }),
        { status: 402 },
      ),
    );
    const client = createHostedClient({
      baseUrl: BASE,
      apiKey: DEMO_TOKEN,
      authScheme: "bearer",
    });
    const err = await client
      .finalize("ses_1", {
        stopReason: "completed",
        exitCode: 0,
        durationMs: 1,
        agentModel: "demo-gateway",
        criteria: [],
        scenarioName: "first-run-demo",
        scenarioHash: "",
        scenarioPrompt: "",
        expectedBehavior: "",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedQuotaError);
    expect((err as HostedQuotaError).details).toMatchObject({
      kind: "daily_judge_cap",
    });
  });
});
