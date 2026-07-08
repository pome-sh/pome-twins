import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHostedClient } from "../../../src/hosted/client.js";
import {
  HostedAuthError,
  HostedQuotaError,
  HostedOrchError,
} from "../../../src/hosted/errors.js";

const BASE = "https://api.example.com";
const KEY = "pme_test_key";

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: typeof fetch) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl as any);
}

describe("HostedClient.createSession", () => {
  it("POSTs base64-encoded scenario_source with X-API-KEY and returns the parsed response", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/v1/sessions`);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(KEY);
      expect(headers.get("content-type")).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        twins: ["github"],
        scenario_source: Buffer.from("# Scenario\n\n[D] true\n").toString("base64"),
      });
      return new Response(
        JSON.stringify({
          session_id: "ses_abc",
          session_token: "pst_test_abc",
          twin_url: "https://twins.example.com/s/ses_abc",
          expires_at: "2026-05-01T20:00:00Z",
          agent_token: "edt_jwt",
          openapi_url: "https://twins.example.com/s/ses_abc/openapi.json",
          per_twin: {},
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.createSession({
      scenarioSource: "# Scenario\n\n[D] true\n",
      twins: ["github"],
    });
    expect(out.session_id).toBe("ses_abc");
    expect(out.twin_url).toBe("https://twins.example.com/s/ses_abc");
    expect(out.agent_token).toBe("edt_jwt");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws HostedAuthError on 401", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { type: "invalid_auth", message: "bad key", request_id: "req_1" } }), {
        status: 401,
      })
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.createSession({ scenarioSource: "x", twins: ["github"] })
    ).rejects.toBeInstanceOf(HostedAuthError);
  });

  it("throws HostedQuotaError on 402", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { type: "quota_exceeded", message: "over", request_id: "req_2" } }), {
        status: 402,
      })
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.createSession({ scenarioSource: "x", twins: ["github"] })
    ).rejects.toBeInstanceOf(HostedQuotaError);
  });

  it("throws HostedOrchError on 503", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { type: "internal_error", message: "spawn failed", request_id: "req_3" } }), {
        status: 503,
      })
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.createSession({ scenarioSource: "x", twins: ["github"] })
    ).rejects.toBeInstanceOf(HostedOrchError);
  });

  it("throws HostedOrchError when the request times out", async () => {
    // Honor the abort signal so the AbortController fires the timeout reject
    // path. Without listening to signal, the mocked promise hangs forever and
    // vitest's own test timeout fires instead.
    mockFetch((_url, init) => new Promise((_resolve, reject) => {
      const sig = (init as RequestInit | undefined)?.signal;
      sig?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    }));
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY, timeoutMs: 5 });
    await expect(
      client.createSession({ scenarioSource: "x", twins: ["github"] })
    ).rejects.toBeInstanceOf(HostedOrchError);
  });

  it("forwards seed when provided so cloud skips markdown extraction", async () => {
    let captured: any;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          session_id: "ses_abc",
          session_token: "pst_test_abc",
          twin_url: "https://twins.example.com/s/ses_abc",
          expires_at: "2026-05-01T20:00:00Z",
          agent_token: "edt_jwt",
          openapi_url: "https://twins.example.com/s/ses_abc/openapi.json",
          per_twin: {},
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const seed = {
      repositories: [{ owner: "acme", name: "api", labels: [{ name: "bug" }] }],
    };
    await client.createSession({
      scenarioSource: "x",
      twins: ["github"],
      seed,
    });
    expect(captured.seed).toEqual(seed);
  });

  it("omits seed from the body when not provided (back-compat with cloud markdown extraction)", async () => {
    let captured: any;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          session_id: "ses_abc",
          session_token: "pst_test_abc",
          twin_url: "https://twins.example.com/s/ses_abc",
          expires_at: "2026-05-01T20:00:00Z",
          agent_token: "edt_jwt",
          openapi_url: "https://twins.example.com/s/ses_abc/openapi.json",
          per_twin: {},
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await client.createSession({ scenarioSource: "x", twins: ["github"] });
    expect("seed" in captured).toBe(false);
  });

  it("forwards agent_id when provided", async () => {
    let captured: any;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          session_id: "ses_abc",
          session_token: "pst_test_abc",
          twin_url: "https://twins.example.com/s/ses_abc",
          expires_at: "2026-05-01T20:00:00Z",
          agent_token: "edt_jwt",
          openapi_url: "https://twins.example.com/s/ses_abc/openapi.json",
          per_twin: {},
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await client.createSession({
      scenarioSource: "x",
      twins: ["github"],
      agentId: "agt_registered",
    });
    expect(captured.agent_id).toBe("agt_registered");
  });

  it("throws HostedOrchError on non-JSON 5xx body (e.g. nginx HTML page)", async () => {
    mockFetch(async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.createSession({ scenarioSource: "x", twins: ["github"] })
    ).rejects.toBeInstanceOf(HostedOrchError);
  });

  it("throws HostedOrchError on 200 with unexpected schema shape", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ wrong: "shape" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.createSession({ scenarioSource: "x", twins: ["github"] })
    ).rejects.toBeInstanceOf(HostedOrchError);
  });
});

describe("HostedClient.fetchState", () => {
  it("GETs ${twin_url}/_pome/state with bearer and returns the parsed JSON", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(String(url)).toBe("https://twins.example.com/s/ses_abc/_pome/state");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer edt_jwt");
      return new Response(
        JSON.stringify({ repositories: [{ owner: "acme", name: "api" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const state = await client.fetchState({
      twinUrl: "https://twins.example.com/s/ses_abc",
      agentToken: "edt_jwt",
    });
    expect(state).toEqual({ repositories: [{ owner: "acme", name: "api" }] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws HostedAuthError on 401 from twin pod", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ message: "Forbidden" }), { status: 401 })
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.fetchState({ twinUrl: "https://twins.example.com/s/ses_abc", agentToken: "edt_jwt" })
    ).rejects.toBeInstanceOf(HostedAuthError);
  });
});

describe("HostedClient.fetchEvents", () => {
  it("GETs ${twin_url}/_pome/events with bearer and returns the parsed array", async () => {
    mockFetch(async (url) => {
      expect(String(url)).toBe("https://twins.example.com/s/ses_abc/_pome/events");
      return new Response(
        JSON.stringify([{ method: "GET", path: "/repos/acme/api", status: 200 }]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const events = await client.fetchEvents({
      twinUrl: "https://twins.example.com/s/ses_abc",
      agentToken: "edt_jwt",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ method: "GET", status: 200 });
  });
});

describe("HostedClient.submitResult", () => {
  it("POSTs base64-encoded blobs + score to /v1/sessions/:id/result and returns parsed response", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/v1/sessions/ses_abc/result`);
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.scenario_name).toBe("00-default-seed");
      expect(body.scenario_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.satisfaction_score).toBe(100);
      expect(body.criteria_results).toEqual([
        { criterion: { type: "deterministic", text: "true" }, passed: true, skipped: false, reason: "trivially true" },
      ]);
      expect(body.judge_model).toBe("none");
      expect(body.judge_tokens_in).toBeNull();
      expect(body.judge_tokens_out).toBeNull();
      expect(Buffer.from(body.trace_jsonl_b64, "base64").toString("utf8")).toContain('"method":"GET"');
      expect(Buffer.from(body.state_initial_json_b64, "base64").toString("utf8")).toBe('{"a":1}');
      expect(Buffer.from(body.state_final_json_b64, "base64").toString("utf8")).toBe('{"a":2}');
      // BYOK Flavor #1: agent_stdout MUST NOT cross the wire.
      expect(body).not.toHaveProperty("agent_stdout");
      expect(body.events_jsonl_url).toBeNull();
      return new Response(
        JSON.stringify({ run_id: "run_xyz", dashboard_url: "https://dashboard.example.com/runs/run_xyz" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.submitResult("ses_abc", {
      scenarioName: "00-default-seed",
      scenarioHash: "a".repeat(64),
      durationMs: 1234,
      agentModel: "unknown",
      satisfactionScore: 100,
      criteriaResults: [
        { criterion: { type: "deterministic", text: "true" }, passed: true, skipped: false, reason: "trivially true" } as any,
      ],
      judgeModel: "none",
      judgeTokensIn: null,
      judgeTokensOut: null,
      lanes: [],
      steps: [],
      fixPrompt: null,
      eventsJsonlUrl: null,
      traceJsonl: '{"method":"GET","path":"/x","status":200}\n',
      stateInitialJson: '{"a":1}',
      stateFinalJson: '{"a":2}',
    });
    expect(out.run_id).toBe("run_xyz");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards events_jsonl_url string when provided", async () => {
    let captured: any;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ run_id: "run_y", dashboard_url: "https://dashboard.example.com/runs/run_y" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await client.submitResult("ses_abc", {
      scenarioName: "00-default-seed",
      scenarioHash: "a".repeat(64),
      durationMs: 1234,
      agentModel: "unknown",
      satisfactionScore: 100,
      criteriaResults: [
        { criterion: { type: "deterministic", text: "true" }, passed: true, skipped: false, reason: "trivially true" } as any,
      ],
      judgeModel: "none",
      judgeTokensIn: null,
      judgeTokensOut: null,
      lanes: [],
      steps: [],
      fixPrompt: null,
      eventsJsonlUrl: "team-tm_x/session-ses_abc/events.jsonl",
      traceJsonl: '{"method":"GET","path":"/x","status":200}\n',
      stateInitialJson: '{"a":1}',
      stateFinalJson: '{"a":2}',
    });
    expect(captured.events_jsonl_url).toBe("team-tm_x/session-ses_abc/events.jsonl");
  });

  it("trims agent_sdk and sends null for blank SDK labels", async () => {
    const captured: unknown[] = [];
    mockFetch(async (_url, init) => {
      captured.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ run_id: "run_y", dashboard_url: "https://dashboard.example.com/runs/run_y" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const input = {
      scenarioName: "00-default-seed",
      scenarioHash: "a".repeat(64),
      durationMs: 1234,
      agentModel: "unknown",
      satisfactionScore: 100,
      criteriaResults: [
        { criterion: { type: "deterministic", text: "true" }, passed: true, skipped: false, reason: "trivially true" } as any,
      ],
      judgeModel: "none",
      judgeTokensIn: null,
      judgeTokensOut: null,
      lanes: [],
      steps: [],
      fixPrompt: null,
      eventsJsonlUrl: null,
      traceJsonl: '{"method":"GET","path":"/x","status":200}\n',
      stateInitialJson: '{"a":1}',
      stateFinalJson: '{"a":2}',
    };

    await client.submitResult("ses_abc", {
      ...input,
      agentSdk: "  claude-agent-sdk  ",
    });
    await client.submitResult("ses_abc", { ...input, agentSdk: "   " });
    await client.submitResult("ses_abc", input);

    expect((captured[0] as { agent_sdk?: unknown }).agent_sdk).toBe(
      "claude-agent-sdk",
    );
    expect((captured[1] as { agent_sdk?: unknown }).agent_sdk).toBeNull();
    expect((captured[2] as { agent_sdk?: unknown }).agent_sdk).toBeNull();
  });
});

describe("HostedClient.finalize", () => {
  it("POSTs criteria definitions to /v1/sessions/:id/finalize and returns parsed response", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/v1/sessions/ses_abc/finalize`);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(KEY);
      expect(headers.get("content-type")).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        stop_reason: "agent_exit_0",
        exit_code: 0,
        duration_ms: 4321,
        agent_model: "unknown",
        agent_sdk: null,
        criteria: [
          { id: "crit_0", text: "No unsupported endpoint was called", kind: "D" },
        ],
        scenario_name: "00-default-seed",
        scenario_hash: "a".repeat(64),
        scenario_prompt: "do the thing",
        expected_behavior: "the thing got done",
        trace_storage_key: "team-tm_x/session-ses_abc/events.jsonl",
      });
      return new Response(
        JSON.stringify({
          run_id: "run_xyz",
          score: 100,
          judge_model: "gpt-4o-mini",
          dashboard_url: "https://dashboard.example.com/runs/run_xyz",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.finalize("ses_abc", {
      stopReason: "agent_exit_0",
      exitCode: 0,
      durationMs: 4321,
      agentModel: "unknown",
      agentSdk: null,
      criteria: [
        { id: "crit_0", text: "No unsupported endpoint was called", kind: "D" },
      ],
      scenarioName: "00-default-seed",
      scenarioHash: "a".repeat(64),
      scenarioPrompt: "do the thing",
      expectedBehavior: "the thing got done",
      traceStorageKey: "team-tm_x/session-ses_abc/events.jsonl",
    });
    expect(out).toEqual({
      run_id: "run_xyz",
      score: 100,
      judge_model: "gpt-4o-mini",
      dashboard_url: "https://dashboard.example.com/runs/run_xyz",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("omits storage-key fields when undefined so cloud falls back to conventional paths", async () => {
    let captured: any;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          run_id: "run_y",
          score: 75,
          judge_model: "gpt-4o-mini",
          dashboard_url: "https://dashboard.example.com/runs/run_y",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await client.finalize("ses_abc", {
      stopReason: "agent_exit_0",
      exitCode: 0,
      durationMs: 1,
      agentModel: "unknown",
      criteria: [],
      scenarioName: "n",
      scenarioHash: "",
      scenarioPrompt: "",
      expectedBehavior: "",
    });
    expect("trace_storage_key" in captured).toBe(false);
    expect("state_initial_storage_key" in captured).toBe(false);
    expect("state_final_storage_key" in captured).toBe(false);
  });

  it("trims agent_sdk and sends null for blank labels", async () => {
    const captured: any[] = [];
    mockFetch(async (_url, init) => {
      captured.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          run_id: "run_y",
          score: 100,
          judge_model: "j",
          dashboard_url: "https://dashboard.example.com/runs/run_y",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const base = {
      stopReason: "agent_exit_0",
      exitCode: 0,
      durationMs: 1,
      agentModel: "unknown",
      criteria: [] as { id: string; text: string; kind: "D" | "P" }[],
      scenarioName: "n",
      scenarioHash: "",
      scenarioPrompt: "",
      expectedBehavior: "",
    };
    await client.finalize("ses_abc", { ...base, agentSdk: "  claude-agent-sdk  " });
    await client.finalize("ses_abc", { ...base, agentSdk: "   " });
    await client.finalize("ses_abc", base);
    expect(captured[0].agent_sdk).toBe("claude-agent-sdk");
    expect(captured[1].agent_sdk).toBeNull();
    expect(captured[2].agent_sdk).toBeNull();
  });

  it("accepts judge_model: null in the response (idempotent-replay edge case)", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          run_id: "run_y",
          score: 100,
          judge_model: null,
          dashboard_url: "https://dashboard.example.com/runs/run_y",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.finalize("ses_abc", {
      stopReason: "agent_exit_0",
      exitCode: 0,
      durationMs: 1,
      agentModel: "unknown",
      criteria: [],
      scenarioName: "n",
      scenarioHash: "",
      scenarioPrompt: "",
      expectedBehavior: "",
    });
    expect(out.judge_model).toBeNull();
  });

  it("throws HostedAuthError on 401", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ error: { type: "invalid_auth", message: "bad key" } }),
        { status: 401 },
      ),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.finalize("ses_abc", {
        stopReason: "agent_exit_0",
        exitCode: 0,
        durationMs: 1,
        agentModel: "unknown",
        criteria: [],
        scenarioName: "n",
        scenarioHash: "",
        scenarioPrompt: "",
        expectedBehavior: "",
      }),
    ).rejects.toBeInstanceOf(HostedAuthError);
  });
});

describe("HostedClient.requestEventsUploadUrl", () => {
  it("POSTs to /v1/sessions/:id/result-upload-url with x-api-key and returns { url, key }", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/v1/sessions/ses_abc/result-upload-url`);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
      return new Response(
        JSON.stringify({
          url: "https://signed.example/put",
          key: "team-tm_x/session-ses_abc/events.jsonl",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.requestEventsUploadUrl("ses_abc");
    expect(out.url).toBe("https://signed.example/put");
    expect(out.key).toBe("team-tm_x/session-ses_abc/events.jsonl");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws HostedAuthError on 401", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ error: { type: "invalid_auth", message: "bad key" } }),
        { status: 401 },
      ),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.requestEventsUploadUrl("ses_abc"),
    ).rejects.toBeInstanceOf(HostedAuthError);
  });

  it("throws HostedOrchError on 404 (endpoint not deployed yet — runner falls back to null)", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ error: { type: "not_found", message: "no route" } }),
        { status: 404 },
      ),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.requestEventsUploadUrl("ses_abc"),
    ).rejects.toBeInstanceOf(HostedOrchError);
  });
});

describe("HostedClient.requestStateUploadUrl", () => {
  it("POSTs to /v1/sessions/:id/state-upload-url with x-api-key and returns the pair of {url, key}", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/v1/sessions/ses_abc/state-upload-url`);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
      return new Response(
        JSON.stringify({
          state_initial: {
            url: "https://signed.example/put-initial",
            key: "team-tm_x/session-ses_abc/state_initial.json",
          },
          state_final: {
            url: "https://signed.example/put-final",
            key: "team-tm_x/session-ses_abc/state_final.json",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.requestStateUploadUrl("ses_abc");
    expect(out.state_initial.url).toBe("https://signed.example/put-initial");
    expect(out.state_initial.key).toBe(
      "team-tm_x/session-ses_abc/state_initial.json",
    );
    expect(out.state_final.url).toBe("https://signed.example/put-final");
    expect(out.state_final.key).toBe(
      "team-tm_x/session-ses_abc/state_final.json",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws HostedAuthError on 401", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ error: { type: "invalid_auth", message: "bad key" } }),
        { status: 401 },
      ),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.requestStateUploadUrl("ses_abc"),
    ).rejects.toBeInstanceOf(HostedAuthError);
  });

  it("throws HostedOrchError on 404 (endpoint not deployed yet — runner falls back to null)", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ error: { type: "not_found", message: "no route" } }),
        { status: 404 },
      ),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.requestStateUploadUrl("ses_abc"),
    ).rejects.toBeInstanceOf(HostedOrchError);
  });

  it("throws HostedOrchError when one of the pair is missing", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          state_initial: { url: "https://x", key: "k" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.requestStateUploadUrl("ses_abc"),
    ).rejects.toBeInstanceOf(HostedOrchError);
  });
});

describe("HostedClient.listSessions", () => {
  const row = {
    id: "ses_list1",
    team_id: "tm_x",
    twin_type: "github",
    twins: ["github"],
    state: "running",
    twin_url: "https://twins.example.com/s/ses_list1",
    created_at: "2026-05-01T12:00:00.000Z",
    ready_at: "2026-05-01T12:00:01.000Z",
    expires_at: "2026-05-01T13:00:00.000Z",
    closed_at: null,
  };

  it("parses a JSON array from GET /v1/sessions", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/v1/sessions?limit=10`);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
      return new Response(JSON.stringify([row]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.listSessions({ limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("ses_list1");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a non-array GET /v1/sessions body", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(client.listSessions()).rejects.toBeInstanceOf(HostedOrchError);
  });

  // F26 — terminal sessions parse cleanly alongside active rows. Unknown
  // extra fields emitted by older/newer cloud builds are tolerated by the
  // schema so parsing keeps working.
  it("parses terminal rows alongside active rows", async () => {
    const terminalRow = {
      ...row,
      state: "expired",
      closed_at: "2026-05-01T13:00:00.000Z",
    };
    mockFetch(async () =>
      new Response(JSON.stringify([terminalRow, row]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.listSessions({ limit: 10 });
    expect(out).toHaveLength(2);
    expect(out[0]?.state).toBe("expired");
    expect(out[0]?.closed_at).toBe("2026-05-01T13:00:00.000Z");
  });
});

describe("HostedClient.getSession", () => {
  it("GETs /v1/sessions/:id with X-API-KEY", async () => {
    const row = {
      id: "ses_one",
      team_id: "tm_x",
      twin_type: "github",
      twins: ["github"],
      state: "ready",
      twin_url: "https://twins.example.com/s/ses_one",
      created_at: "2026-05-01T12:00:00.000Z",
      ready_at: "2026-05-01T12:00:01.000Z",
      expires_at: "2026-05-01T13:00:00.000Z",
      closed_at: null,
    };
    mockFetch(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/v1/sessions/ses_one`);
      expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
      return new Response(JSON.stringify(row), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.getSession("ses_one");
    expect(out.id).toBe("ses_one");
    expect(out.state).toBe("ready");
  });
});

describe("HostedClient.deleteSession", () => {
  it("DELETEs /v1/sessions/:id and treats 204 (per cloud spec) as success", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await client.deleteSession("ses_abc"); // resolves
    expect(calls).toBe(1);
  });

  it("also tolerates 200 (forward-compat if the control-plane ever returns a body)", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ id: "ses_abc", state: "expired" }), { status: 200 }),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await client.deleteSession("ses_abc"); // does not throw
  });

  it("does NOT throw on 409 already-closed (best-effort teardown)", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { type: "conflict", message: "already done" } }), { status: 409 })
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await client.deleteSession("ses_abc"); // does not throw
  });

  it("does NOT throw when the network drops mid-DELETE (best-effort teardown)", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await client.deleteSession("ses_abc"); // does not throw — TTL reaps server-side
  });

  it("throws on 404 when bestEffort is false (CLI session stop)", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { type: "not_found", message: "gone" } }), { status: 404 }),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    await expect(client.deleteSession("ses_missing", false)).rejects.toBeInstanceOf(HostedOrchError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FDRS-643 live-run regressions (first real cloud round-trip, 2026-07-05)
// ─────────────────────────────────────────────────────────────────────────────

describe("FDRS-643 live-run regressions", () => {
  it("parses a finalize response whose criteria_results use the code/model vocabulary (post-W3 cloud)", async () => {
    // The cloud judge emits the unified vocabulary (criterion.type
    // "code"/"model") since shared-types 0.5.0; the response reader must
    // tolerate BOTH vocabularies (found live: every demo trial errored
    // "unexpected response shape: invalid_union").
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          run_id: "run_w3",
          score: 100,
          judge_model: "google/gemini-2.5-flash",
          dashboard_url: "https://app.pome.sh/runs/run_w3",
          criteria_results: [
            {
              criterion: { type: "model", text: "labels applied correctly" },
              passed: true,
              skipped: false,
              reason: "ok",
              confidence: 0.9,
              judge_model: "google/gemini-2.5-flash",
            },
            {
              criterion: { type: "code", text: "no new labels created" },
              passed: true,
              skipped: false,
              reason: "ok",
            },
          ],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createHostedClient({ baseUrl: BASE, apiKey: KEY });
    const out = await client.finalize("ses_abc", {
      stopReason: "agent_exit_0",
      exitCode: 0,
      durationMs: 4321,
      agentModel: "unknown",
      agentSdk: null,
      criteria: [],
      scenarioName: "first-run-demo",
      scenarioHash: "a".repeat(64),
      scenarioPrompt: "p",
      expectedBehavior: "e",
      traceStorageKey: "team-tm_x/session-ses_abc/events.jsonl",
    });
    expect(out.criteria_results).toHaveLength(2);
    expect(out.criteria_results?.[0]?.criterion.type).toBe("model");
    expect(out.criteria_results?.[1]?.criterion.type).toBe("code");
  });

  it("sends Authorization: Bearer on DELETE when authScheme is bearer (demo teardown)", async () => {
    let sawAuth: string | null = null;
    let sawApiKey: string | null = null;
    mockFetch(async (_url, init) => {
      const headers = new Headers(init?.headers);
      sawAuth = headers.get("authorization");
      sawApiKey = headers.get("x-api-key");
      return new Response(null, { status: 204 });
    });
    const client = createHostedClient({
      baseUrl: BASE,
      apiKey: "eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJ4In0.c2ln",
      authScheme: "bearer",
    });
    await client.deleteSession("ses_abc", false);
    expect(sawAuth).toBe("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJ4In0.c2ln");
    expect(sawApiKey).toBeNull();
  });
});
