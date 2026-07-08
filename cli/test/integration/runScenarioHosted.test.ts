import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { sign as signJwt } from "hono/jwt";
import { runScenarioHosted } from "../../src/runner/runScenarioHosted.js";

let cloudServer: ServerType | undefined;
let cloudPort = 0;

const TWIN_AUTH_SECRET = "test-secret-32-chars-minimum-length";

const FAKE_SESSION_ID = "ses_test123";
const FAKE_RUN_ID = "run_test456";

async function startFakeCloud(opts?: { finalizeScore?: number }) {
  const finalizeScore = opts?.finalizeScore ?? 100;
  const app = new Hono();
  let receivedFinalize: unknown = null;
  let chatCompletionCalls = 0;

  app.post("/v1/sessions", async (c) => {
    const token = await signJwt(
      { sid: FAKE_SESSION_ID, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) + 600 },
      TWIN_AUTH_SECRET
    );
    return c.json({
      session_id: FAKE_SESSION_ID,
      session_token: "pst_test_hosted",
      twin_url: `http://127.0.0.1:${cloudPort}/s/${FAKE_SESSION_ID}`,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      agent_token: token,
      openapi_url: `http://127.0.0.1:${cloudPort}/openapi.json`,
      per_twin: {},
    });
  });

  // Twin-pod stand-ins served from the same fake cloud for test simplicity.
  app.get("/s/:sid/_pome/state", (c) =>
    c.json({
      repositories: [
        {
          owner: "acme",
          name: "api",
          full_name: "acme/api",
          labels: [],
          issues: [],
        },
      ],
    })
  );
  // Full RecorderEvent shape — correlator (FDRS-326) reads ts/twin/tool_call_id.
  app.get("/s/:sid/_pome/events", (c) =>
    c.json([
      {
        ts: "2026-05-11T00:00:02.000Z",
        run_id: "run_fixture",
        twin: "github",
        request_id: "req_1",
        step_id: null,
        tool_call_id: "tc_1",
        method: "GET",
        path: "/repos/acme/api",
        request_body: null,
        status: 200,
        response_body: { full_name: "acme/api" },
        latency_ms: 5,
        fidelity: "semantic",
        state_mutation: false,
        state_delta: null,
        error: null,
      },
    ])
  );

  // ADR-013 — /finalize is the authoritative finalize route. Cloud judges,
  // CLI prints the returned `score`.
  app.post("/v1/sessions/:id/finalize", async (c) => {
    receivedFinalize = await c.req.json();
    return c.json(
      {
        run_id: FAKE_RUN_ID,
        score: finalizeScore,
        judge_model: "test-judge",
        dashboard_url: `http://127.0.0.1:${cloudPort}/runs/${FAKE_RUN_ID}`,
      },
      201,
    );
  });
  // If anything still POSTs to /result, fail loudly so tests catch it.
  app.post("/v1/sessions/:id/result", (c) =>
    c.json({ error: { type: "gone", message: "use /finalize" } }, 410),
  );
  // BYOK LLM judge endpoint stand-in. Counted so tests can assert the CLI
  // never calls a local judge in hosted mode (ADR-013 — cloud judges).
  app.post("/v1/chat/completions", (c) => {
    chatCompletionCalls += 1;
    return c.json({
      choices: [{ message: { content: "should-not-be-called" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
  });
  app.delete("/v1/sessions/:id", (c) =>
    c.json({ id: c.req.param("id"), state: "expired" })
  );

  cloudPort = await new Promise<number>((res) => {
    cloudServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => res(info.port));
  });
  return {
    getFinalize: () => receivedFinalize,
    getChatCompletionCalls: () => chatCompletionCalls,
  };
}

// Note (deviation from plan): the plan's literal scenario fixture
// "# Trivial\n\nPretend prompt.\n\n[D] true\n" is not parseable by parseScenario
// (which requires a `## Prompt` and `## Success Criteria` section, plus a non-trivial
// criterion the deterministic evaluator can match). We use an equivalent fixture
// that produces the same satisfaction_score=100 result.
const TRIVIAL_PASSING_SCENARIO =
  "# Trivial\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [D] No unsupported endpoint was called\n";

describe("runScenarioHosted happy path", () => {
  let tmp: string;
  let getFinalize: () => unknown;
  let getChatCompletionCalls: () => number;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-hosted-"));
    const handles = await startFakeCloud();
    getFinalize = handles.getFinalize;
    getChatCompletionCalls = handles.getChatCompletionCalls;
  });

  afterEach(async () => {
    cloudServer?.close();
    cloudServer = undefined;
    cloudPort = 0;
    await rm(tmp, { recursive: true, force: true });
  });

  it("POSTs criteria definitions to /finalize and returns the cloud-judged score", async () => {
    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");
    const stubAgent = `node -e ${JSON.stringify("console.log('done')")}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: stubAgent,
      artifactsDir: join(tmp, "runs"),
      hosted: {
        baseUrl: `http://127.0.0.1:${cloudPort}`,
        apiKey: "pme_test",
      },
    });

    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    expect(result.score.satisfaction).toBe(100);
    expect(result.exitCode).toBe(0);

    const received = getFinalize() as Record<string, unknown>;
    expect(received).not.toBeNull();
    expect(received.scenario_name).toBe("scn"); // slug from filename
    expect(received.scenario_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(received.scenario_prompt).toBe("Pretend prompt.");
    expect(received.expected_behavior).toBe("");
    expect(received.stop_reason).toBe("agent_exit_0");
    expect(received.exit_code).toBe(0);
    expect(received.agent_model).toBe("unknown");
    // Criterion *definitions*, not results — ADR-013 cloud judges them.
    expect(received.criteria).toEqual([
      { id: "crit_0", text: "No unsupported endpoint was called", kind: "D" },
    ]);
    // BYOK posture: agent_stdout MUST NOT be in body. /finalize never carried
    // it, but assert anyway to lock the boundary.
    expect(received).not.toHaveProperty("agent_stdout");
    // No CLI-side scoring crosses the wire.
    expect(received).not.toHaveProperty("satisfaction_score");
    expect(received).not.toHaveProperty("criteria_results");
    expect(received).not.toHaveProperty("trace_jsonl_b64");
    expect(received).not.toHaveProperty("fix_prompt");
  });

  // ADR-013: hosted runs do not call any local LLM judge — cloud judges
  // authoritatively. Even when legacy LLM env vars are present, the CLI must
  // not POST to /v1/chat/completions during a hosted run.
  it("does not call a local LLM judge in hosted mode even when env vars are set", async () => {
    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");
    const stubAgent = `node -e ${JSON.stringify("console.log('done')")}`;

    process.env.POME_LLM_BASE_URL = `http://127.0.0.1:${cloudPort}/v1`;
    process.env.POME_LLM_API_KEY = "test-key";
    process.env.POME_LLM_MODEL = "test-model";
    try {
      await runScenarioHosted({
        scenarioPath,
        agentCommand: stubAgent,
        artifactsDir: join(tmp, "runs"),
        hosted: {
          baseUrl: `http://127.0.0.1:${cloudPort}`,
          apiKey: "pme_test",
        },
      });
    } finally {
      delete process.env.POME_LLM_BASE_URL;
      delete process.env.POME_LLM_API_KEY;
      delete process.env.POME_LLM_MODEL;
    }

    expect(getChatCompletionCalls()).toBe(0);
  });

  it("hosted PASS holds even without any local LLM key (regression: stale local-eval score)", async () => {
    const scenarioPath = join(tmp, "scn.md");
    // Probabilistic criterion — pre-fix path would skip it locally without
    // an LLM key, pulling local satisfaction below the threshold and printing
    // FAIL despite cloud judging PASS. Post-fix: local evaluator never runs.
    await writeFile(
      scenarioPath,
      "# P-only\n\n## Prompt\np\n\n## Success Criteria\n- [P] Agent did something reasonable\n",
      "utf8",
    );
    const saved = {
      open: process.env.OPENAI_API_KEY,
      anth: process.env.ANTHROPIC_API_KEY,
      pome: process.env.POME_LLM_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.POME_LLM_API_KEY;
    try {
      const result = await runScenarioHosted({
        scenarioPath,
        agentCommand: `node -e ${JSON.stringify("console.log('done')")}`,
        artifactsDir: join(tmp, "runs"),
        hosted: {
          baseUrl: `http://127.0.0.1:${cloudPort}`,
          apiKey: "pme_test",
        },
      });
      expect(result.score.satisfaction).toBe(100);
      expect(result.exitCode).toBe(0);
    } finally {
      if (saved.open !== undefined) process.env.OPENAI_API_KEY = saved.open;
      if (saved.anth !== undefined) process.env.ANTHROPIC_API_KEY = saved.anth;
      if (saved.pome !== undefined) process.env.POME_LLM_API_KEY = saved.pome;
    }
  });
});

describe("runScenarioHosted with upload route stubbed", () => {
  // Separate describe with its own minimal fake server that includes both the
  // upload-url endpoint and a fake PUT target. This proves the end-to-end wire
  // format (FDRS-357 happy path).
  let uploadServer: ServerType | undefined;
  let uploadPort = 0;
  let uploadTmp: string | undefined;

  afterEach(async () => {
    uploadServer?.close();
    uploadServer = undefined;
    uploadPort = 0;
    if (uploadTmp) {
      await rm(uploadTmp, { recursive: true, force: true });
      uploadTmp = undefined;
    }
  });

  it("PUTs the events JSONL to the signed URL and forwards the key as trace_storage_key on /finalize", async () => {
    let putBody: string | null = null;
    let receivedFinalize: unknown = null;

    const app = new Hono();

    app.post("/v1/sessions", async (c) => {
      const token = await signJwt(
        { sid: FAKE_SESSION_ID, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) + 600 },
        TWIN_AUTH_SECRET
      );
      return c.json({
        session_id: FAKE_SESSION_ID,
        session_token: "pst_test_hosted",
        twin_url: `http://127.0.0.1:${uploadPort}/s/${FAKE_SESSION_ID}`,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        agent_token: token,
        openapi_url: `http://127.0.0.1:${uploadPort}/openapi.json`,
        per_twin: {},
      });
    });

    app.get("/s/:sid/_pome/state", (c) =>
      c.json({
        repositories: [
          {
            owner: "acme",
            name: "api",
            full_name: "acme/api",
            labels: [],
            issues: [],
          },
        ],
      })
    );

    app.get("/s/:sid/_pome/events", (c) =>
      c.json([
        {
          ts: "2026-05-11T00:00:02.000Z",
          run_id: "run_fixture",
          twin: "github",
          request_id: "req_1",
          step_id: null,
          tool_call_id: "tc_1",
          method: "GET",
          path: "/repos/acme/api",
          request_body: null,
          status: 200,
          response_body: { full_name: "acme/api" },
          latency_ms: 5,
          fidelity: "semantic",
          state_mutation: false,
          state_delta: null,
          error: null,
        },
      ])
    );

    app.post("/v1/sessions/:id/result-upload-url", (c) => {
      const sid = c.req.param("id");
      return c.json({
        url: `http://127.0.0.1:${uploadPort}/__fake_put`,
        key: `team-tm_test/session-${sid}/events.jsonl`,
      });
    });

    app.post("/v1/sessions/:id/state-upload-url", (c) => {
      const sid = c.req.param("id");
      return c.json({
        state_initial: {
          url: `http://127.0.0.1:${uploadPort}/__fake_put_state_initial`,
          key: `team-tm_test/session-${sid}/state_initial.json`,
        },
        state_final: {
          url: `http://127.0.0.1:${uploadPort}/__fake_put_state_final`,
          key: `team-tm_test/session-${sid}/state_final.json`,
        },
      });
    });

    let stateInitialBody: string | null = null;
    let stateFinalBody: string | null = null;

    app.put("/__fake_put", async (c) => {
      putBody = await c.req.text();
      return new Response(null, { status: 200 });
    });
    app.put("/__fake_put_state_initial", async (c) => {
      stateInitialBody = await c.req.text();
      return new Response(null, { status: 200 });
    });
    app.put("/__fake_put_state_final", async (c) => {
      stateFinalBody = await c.req.text();
      return new Response(null, { status: 200 });
    });

    app.post("/v1/sessions/:id/finalize", async (c) => {
      receivedFinalize = await c.req.json();
      return c.json(
        {
          run_id: FAKE_RUN_ID,
          score: 100,
          judge_model: "test-judge",
          dashboard_url: `http://127.0.0.1:${uploadPort}/runs/${FAKE_RUN_ID}`,
        },
        201,
      );
    });

    app.delete("/v1/sessions/:id", (c) =>
      c.json({ id: c.req.param("id"), state: "expired" })
    );

    uploadPort = await new Promise<number>((res) => {
      uploadServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => res(info.port));
    });

    uploadTmp = await mkdtemp(join(tmpdir(), "pome-hosted-upload-"));
    const scenarioPath = join(uploadTmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");
    const stubAgent = `node -e ${JSON.stringify("console.log('done')")}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: stubAgent,
      artifactsDir: join(uploadTmp, "runs"),
      hosted: {
        baseUrl: `http://127.0.0.1:${uploadPort}`,
        apiKey: "pme_test",
      },
    });

    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    expect(result.score.satisfaction).toBe(100);

    // /finalize must carry the storage key as trace_storage_key.
    const received = receivedFinalize as Record<string, unknown>;
    expect(received).not.toBeNull();
    expect(received.trace_storage_key).toBe(
      `team-tm_test/session-${FAKE_SESSION_ID}/events.jsonl`,
    );
    // FDRS-395: /finalize must also carry both state storage keys so the
    // cloud judge loads the real twin state instead of substituting "{}".
    expect(received.state_initial_storage_key).toBe(
      `team-tm_test/session-${FAKE_SESSION_ID}/state_initial.json`,
    );
    expect(received.state_final_storage_key).toBe(
      `team-tm_test/session-${FAKE_SESSION_ID}/state_final.json`,
    );

    // The PUT body must be valid NDJSON containing the recorder event.
    expect(putBody).not.toBeNull();
    const firstLine = (putBody as unknown as string).split("\n")[0];
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    expect(parsed.method).toBe("GET");
    expect(parsed.twin).toBe("github");
    expect(parsed.fidelity).toBe("semantic");

    // FDRS-395: state PUT bodies must be valid JSON copies of the twin state
    // returned from /_pome/state.
    expect(stateInitialBody).not.toBeNull();
    expect(stateFinalBody).not.toBeNull();
    const initialParsed = JSON.parse(stateInitialBody as unknown as string) as {
      repositories: { full_name: string }[];
    };
    const finalParsed = JSON.parse(stateFinalBody as unknown as string) as {
      repositories: { full_name: string }[];
    };
    expect(initialParsed.repositories[0]?.full_name).toBe("acme/api");
    expect(finalParsed.repositories[0]?.full_name).toBe("acme/api");
  });
});

describe("runScenarioHosted failure paths", () => {
  // Each test starts a fresh fake cloud configured for one specific failure.
  let failTmp: string | undefined;
  afterEach(async () => {
    cloudServer?.close();
    cloudServer = undefined;
    cloudPort = 0;
    if (failTmp) {
      await rm(failTmp, { recursive: true, force: true });
      failTmp = undefined;
    }
  });

  it("propagates HostedAuthError so the caller can exit 3", async () => {
    const app = new Hono();
    app.post("/v1/sessions", (c) =>
      c.json({ error: { type: "invalid_auth", message: "bad key" } }, 401)
    );
    const port = await new Promise<number>((res) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => res(info.port));
      cloudServer = s;
    });
    failTmp = await mkdtemp(join(tmpdir(), "pome-hosted-"));
    const scenarioPath = join(failTmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");

    await expect(
      runScenarioHosted({
        scenarioPath,
        agentCommand: "true",
        artifactsDir: join(failTmp, "runs"),
        hosted: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "pme_bad" },
      })
    ).rejects.toThrow(/bad key/);
  });

  it("still calls /finalize when the agent times out (V1 still records the run)", async () => {
    let finalizePosts = 0;
    let receivedFinalize: Record<string, unknown> | null = null;
    const app = new Hono();
    app.post("/v1/sessions", async (c) => {
      const token = await signJwt(
        { sid: FAKE_SESSION_ID, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) + 600 },
        TWIN_AUTH_SECRET
      );
      return c.json({
        session_id: FAKE_SESSION_ID,
        session_token: "pst_test_hosted",
        twin_url: `http://127.0.0.1:${cloudPort}/s/${FAKE_SESSION_ID}`,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        agent_token: token,
        openapi_url: "http://127.0.0.1/openapi.json",
        per_twin: {},
      });
    });
    app.get("/s/:sid/_pome/state", (c) =>
      c.json({
        repositories: [
          {
            owner: "acme",
            name: "api",
            full_name: "acme/api",
            labels: [],
            issues: [],
          },
        ],
      })
    );
    app.get("/s/:sid/_pome/events", (c) => c.json([]));
    app.post("/v1/sessions/:id/finalize", async (c) => {
      finalizePosts += 1;
      receivedFinalize = (await c.req.json()) as Record<string, unknown>;
      return c.json(
        {
          run_id: "run_x",
          score: 0,
          judge_model: "test-judge",
          dashboard_url: "http://127.0.0.1/runs/run_x",
        },
        201,
      );
    });
    app.delete("/v1/sessions/:id", (c) => c.json({ id: c.req.param("id"), state: "expired" }));

    cloudPort = await new Promise<number>((res) => {
      cloudServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => res(info.port));
    });
    failTmp = await mkdtemp(join(tmpdir(), "pome-hosted-"));
    const scenarioPath = join(failTmp, "scn.md");
    // timeout = 1s but agent sleeps 5s
    await writeFile(
      scenarioPath,
      "# Slow\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [D] No unsupported endpoint was called\n\n## Config\n```yaml\ntimeout: 1\n```\n",
      "utf8"
    );
    const sleepingAgent = `node -e ${JSON.stringify("setTimeout(() => {}, 5000)")}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: sleepingAgent,
      artifactsDir: join(failTmp, "runs"),
      hosted: { baseUrl: `http://127.0.0.1:${cloudPort}`, apiKey: "pme_test" },
    });

    // F18 / F0-5 — once /finalize returns, the cloud-judged score is
    // canonical. Score 0 < passThreshold (100 default) → exit 1
    // ("below threshold"). The old "agent timeout trumps to exit 3"
    // policy stole the documented auth slot for a non-auth condition.
    // V1 still posts /finalize on timeout so the run is visible in the
    // dashboard. The alternative (no post on timeout) loses signal.
    expect(result.exitCode).toBe(1);
    expect(finalizePosts).toBe(1);
    expect(receivedFinalize).not.toBeNull();
    expect(receivedFinalize!.stop_reason).toBe("agent_timeout");
  });
});
