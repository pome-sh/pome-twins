// SPDX-License-Identifier: Apache-2.0
// Unit tests for `pome eval <run-dir>` (FDRS-656): run-dir validation with
// per-file named errors, meta.json parsing / agent+task derivation, and the
// upload+finalize flow against a mocked EvalClient (matching the stub
// patterns in runScenarioHosted.upload.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveEvalIdentity,
  parseRunMeta,
  readRunDirArtifacts,
  runEval,
  runEvalCommand,
  type EvalClient,
} from "../../src/cli/eval.js";
import { HostedAuthError, HostedOrchError, HostedUsageError } from "../../src/hosted/errors.js";
import type { FinalizeInput } from "../../src/hosted/client.js";
import type { FinalizeResponse } from "../../src/types/shared.js";

const FAKE_SESSION_ID = "ses_eval_test";
const FAKE_RUN_ID = "run_eval_test";
const EVENTS_URL = "https://signed.example/put-events";
const EVENTS_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/events.jsonl`;
const STATE_INITIAL_URL = "https://signed.example/put-state-initial";
const STATE_FINAL_URL = "https://signed.example/put-state-final";
const STATE_INITIAL_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/state_initial.json`;
const STATE_FINAL_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/state_final.json`;
const SIGNALS_URL = "https://signed.example/put-signals";
const SIGNALS_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/signals.jsonl`;

const META = {
  run_id: "ses_original_run",
  scenario: "01-bug-happy-path",
  title: "Bug happy path",
  started_at: "2026-06-30T10:00:00.000Z",
  completed_at: "2026-06-30T10:00:30.000Z",
  exit_code: 0,
  twins: ["github"],
};

const EVENT_LINE = JSON.stringify({
  kind: "TwinHttpEvent",
  event_id: "req_1",
  parent_id: null,
  ts: "2026-06-30T10:00:02.000Z",
  run_id: "ses_original_run",
  twin: "github",
  request_id: "req_1",
  method: "GET",
  path: "/repos/acme/api",
  status: 200,
});

async function writeRunDir(
  root: string,
  overrides: { omit?: string[]; meta?: unknown; eventsJsonl?: string } = {},
): Promise<string> {
  const runDir = join(root, "runs", "01-bug-happy-path", "ses_original_run");
  await mkdir(runDir, { recursive: true });
  const omit = new Set(overrides.omit ?? []);
  if (!omit.has("meta.json")) {
    const meta = overrides.meta !== undefined ? overrides.meta : META;
    await writeFile(
      join(runDir, "meta.json"),
      typeof meta === "string" ? meta : JSON.stringify(meta, null, 2),
    );
  }
  if (!omit.has("events.jsonl")) {
    await writeFile(
      join(runDir, "events.jsonl"),
      overrides.eventsJsonl ?? `${EVENT_LINE}\n`,
    );
  }
  if (!omit.has("state_initial.json")) {
    await writeFile(join(runDir, "state_initial.json"), '{"repositories": []}\n');
  }
  if (!omit.has("state_final.json")) {
    await writeFile(join(runDir, "state_final.json"), '{"repositories": []}\n');
  }
  return runDir;
}

function markerJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: FAKE_SESSION_ID,
    api_url: "http://no-cloud.invalid",
    agent: "triage-bot",
    task_name: "01-bug-happy-path",
    ...overrides,
  });
}

function makeEvalClient({
  finalizeImpl,
  createImpl,
}: {
  finalizeImpl?: (sessionId: string, input: FinalizeInput) => Promise<FinalizeResponse>;
  createImpl?: () => Promise<{ session_id: string; expires_at: string }>;
} = {}): {
  client: EvalClient;
  calls: {
    create: { agent: string; taskName: string }[];
    finalize: { sessionId: string; input: FinalizeInput }[];
  };
} {
  const calls: {
    create: { agent: string; taskName: string }[];
    finalize: { sessionId: string; input: FinalizeInput }[];
  } = { create: [], finalize: [] };

  const client: EvalClient = {
    async createEvalSession(input) {
      calls.create.push(input);
      if (createImpl) return createImpl();
      return {
        session_id: FAKE_SESSION_ID,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    async requestEventsUploadUrl() {
      return { url: EVENTS_URL, key: EVENTS_KEY };
    },
    async requestStateUploadUrl() {
      return {
        state_initial: { url: STATE_INITIAL_URL, key: STATE_INITIAL_KEY },
        state_final: { url: STATE_FINAL_URL, key: STATE_FINAL_KEY },
      };
    },
    async requestSignalsUploadUrl() {
      return { url: SIGNALS_URL, key: SIGNALS_KEY };
    },
    async finalize(sessionId, input) {
      calls.finalize.push({ sessionId, input });
      if (finalizeImpl) return finalizeImpl(sessionId, input);
      return {
        run_id: FAKE_RUN_ID,
        score: 100,
        judge_model: "test-judge",
        dashboard_url: `https://dashboard.example.com/runs/${FAKE_RUN_ID}`,
      };
    },
  };

  return { client, calls };
}

function mockPutFetch(): { putUrls: () => string[] } {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const urlStr = String(url);
    if ((init as RequestInit | undefined)?.method === "PUT") {
      urls.push(urlStr);
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected fetch call to ${urlStr}`);
  });
  return { putUrls: () => urls };
}

describe("pome eval run-dir validation (FDRS-656)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-eval-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  it("accepts a complete run dir (signals.jsonl absent → null)", async () => {
    const runDir = await writeRunDir(tmp);
    const artifacts = await readRunDirArtifacts(runDir);
    expect(artifacts.meta.scenario).toBe("01-bug-happy-path");
    expect(artifacts.eventsJsonl).toContain('"TwinHttpEvent"');
    expect(artifacts.signalsJsonl).toBeNull();
  });

  it("reads signals.jsonl when present", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(join(runDir, "signals.jsonl"), '{"kind":"HookEvent","event_id":"hk_1"}\n');
    const artifacts = await readRunDirArtifacts(runDir);
    expect(artifacts.signalsJsonl).toContain('"HookEvent"');
  });

  it("nonexistent run dir → named usage error", async () => {
    await expect(readRunDirArtifacts(join(tmp, "nope"))).rejects.toThrow(
      /run directory not found/,
    );
  });

  it.each(["meta.json", "events.jsonl", "state_initial.json", "state_final.json"])(
    "missing %s → error naming the file",
    async (file) => {
      const runDir = await writeRunDir(tmp, { omit: [file] });
      const err = await readRunDirArtifacts(runDir).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HostedUsageError);
      expect((err as Error).message).toContain(file);
      expect((err as Error).message).toContain("not found");
    },
  );

  it("corrupt meta.json → error naming meta.json", async () => {
    const runDir = await writeRunDir(tmp, { meta: "{not json" });
    await expect(readRunDirArtifacts(runDir)).rejects.toThrow(
      /meta\.json is corrupt/,
    );
  });

  it("meta.json that is not an object → named error", async () => {
    const runDir = await writeRunDir(tmp, { meta: "[1,2]" });
    await expect(readRunDirArtifacts(runDir)).rejects.toThrow(
      /meta\.json is corrupt — expected a JSON object/,
    );
  });

  it("corrupt events.jsonl line → error naming events.jsonl and the line", async () => {
    const runDir = await writeRunDir(tmp, {
      eventsJsonl: `${EVENT_LINE}\nnot-json-here\n`,
    });
    await expect(readRunDirArtifacts(runDir)).rejects.toThrow(
      /events\.jsonl is corrupt — line 2/,
    );
  });

  it("empty events.jsonl → named error (nothing to evaluate)", async () => {
    const runDir = await writeRunDir(tmp, { eventsJsonl: "\n" });
    await expect(readRunDirArtifacts(runDir)).rejects.toThrow(
      /events\.jsonl is empty/,
    );
  });

  it("corrupt signals.jsonl → error naming signals.jsonl", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(join(runDir, "signals.jsonl"), "garbage{\n");
    await expect(readRunDirArtifacts(runDir)).rejects.toThrow(
      /signals\.jsonl is corrupt — line 1/,
    );
  });
});

describe("pome eval meta parsing + identity derivation (FDRS-656)", () => {
  it("parses the fields writeRunArtifactsCore persists", () => {
    const meta = parseRunMeta(META);
    expect(meta).toEqual({
      runId: "ses_original_run",
      scenario: "01-bug-happy-path",
      title: "Bug happy path",
      startedAt: "2026-06-30T10:00:00.000Z",
      completedAt: "2026-06-30T10:00:30.000Z",
      exitCode: 0,
    });
  });

  it("tolerates missing optional fields", () => {
    const meta = parseRunMeta({});
    expect(meta.scenario).toBeNull();
    expect(meta.exitCode).toBeNull();
  });

  it("task_name defaults to meta scenario slug; --task wins", () => {
    const meta = parseRunMeta(META);
    expect(deriveEvalIdentity(meta, { agent: "a" }, null).taskName).toBe(
      "01-bug-happy-path",
    );
    expect(
      deriveEvalIdentity(meta, { agent: "a", task: "custom-task" }, null).taskName,
    ).toBe("custom-task");
  });

  it("task_name falls back to meta title when scenario is absent", () => {
    const meta = parseRunMeta({ title: "Only title" });
    expect(deriveEvalIdentity(meta, { agent: "a" }, null).taskName).toBe(
      "Only title",
    );
  });

  it("no scenario/title and no --task → usage error naming --task", () => {
    const meta = parseRunMeta({});
    expect(() => deriveEvalIdentity(meta, { agent: "a" }, null)).toThrow(/--task/);
  });

  it("agent precedence: --agent > config agentSlug > config agentId", () => {
    const meta = parseRunMeta(META);
    const config = { agentSlug: "triage-bot", agentId: "agt_123" };
    expect(deriveEvalIdentity(meta, { agent: "cli-agent" }, config).agent).toBe(
      "cli-agent",
    );
    expect(deriveEvalIdentity(meta, {}, config).agent).toBe("triage-bot");
    expect(deriveEvalIdentity(meta, {}, { agentId: "agt_123" }).agent).toBe(
      "agt_123",
    );
  });

  it("no agent anywhere → usage error naming --agent and pome register", () => {
    const meta = parseRunMeta(META);
    expect(() => deriveEvalIdentity(meta, {}, null)).toThrow(/--agent/);
    expect(() => deriveEvalIdentity(meta, {}, null)).toThrow(/pome register agent/);
  });
});

describe("pome eval upload + finalize flow (FDRS-656)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-eval-flow-"));
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  it("happy path: mints an eval session, uploads blobs, finalizes with storage keys", async () => {
    const runDir = await writeRunDir(tmp);
    const { client, calls } = makeEvalClient();
    const { putUrls } = mockPutFetch();

    const result = await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    // Session minted from the FDRS-655 contract body.
    expect(calls.create).toEqual([
      { agent: "triage-bot", taskName: "01-bug-happy-path" },
    ]);
    // All three required blobs PUT to their signed URLs (no signals.jsonl).
    expect(putUrls().sort()).toEqual(
      [EVENTS_URL, STATE_FINAL_URL, STATE_INITIAL_URL].sort(),
    );
    // Finalize on the minted session with explicit storage-key overrides and
    // NO client-side criteria/score (ADR-013: cloud judges).
    expect(calls.finalize).toHaveLength(1);
    expect(calls.finalize[0]!.sessionId).toBe(FAKE_SESSION_ID);
    const input = calls.finalize[0]!.input;
    expect(input.stopReason).toBe("eval_upload");
    expect(input.criteria).toEqual([]);
    expect(input.scenarioName).toBe("01-bug-happy-path");
    expect(input.exitCode).toBe(0);
    expect(input.durationMs).toBe(30_000);
    expect(input.traceStorageKey).toBe(EVENTS_KEY);
    expect(input.stateInitialStorageKey).toBe(STATE_INITIAL_KEY);
    expect(input.stateFinalStorageKey).toBe(STATE_FINAL_KEY);
    expect(input.signalsStorageKey).toBeUndefined();

    // Cloud verdict surfaces untouched.
    expect(result.score.satisfaction).toBe(100);
    expect(result.exitCode).toBe(0);
    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    expect(result.reusedSession).toBe(false);

    // FDRS-657 — the eval-session marker is persisted for idempotent
    // re-upload, but the cloud verdict is EPHEMERAL: NO score.json is written
    // next to the trace. Local artifacts stay trace/audit only.
    expect(existsSync(join(runDir, "eval-session.json"))).toBe(true);
    expect(existsSync(join(runDir, "score.json"))).toBe(false);
  });

  it("uploads signals.jsonl and forwards signalsStorageKey when present", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(
      join(runDir, "signals.jsonl"),
      '{"kind":"HookEvent","event_id":"hk_1"}\n',
    );
    const { client, calls } = makeEvalClient();
    const { putUrls } = mockPutFetch();

    await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    expect(putUrls()).toContain(SIGNALS_URL);
    expect(calls.finalize[0]!.input.signalsStorageKey).toBe(SIGNALS_KEY);
  });

  it("sub-threshold cloud score → exitCode 1, score surfaced verbatim", async () => {
    const runDir = await writeRunDir(tmp);
    const { client } = makeEvalClient({
      finalizeImpl: async () => ({
        run_id: FAKE_RUN_ID,
        score: 40,
        judge_model: "test-judge",
        dashboard_url: `https://dashboard.example.com/runs/${FAKE_RUN_ID}`,
      }),
    });
    mockPutFetch();

    const result = await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    expect(result.score.satisfaction).toBe(40);
    expect(result.exitCode).toBe(1);
  });

  it("re-run on the same dir reuses the stored session (finalize fast-path), not a new mint", async () => {
    const runDir = await writeRunDir(tmp);
    const { client, calls } = makeEvalClient();
    mockPutFetch();

    const hosted = { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" };
    const first = await runEval({ runDir, agent: "triage-bot", hosted, client, projectConfig: null });
    const second = await runEval({ runDir, agent: "triage-bot", hosted, client, projectConfig: null });

    // Only the first run mints; the second finalizes the SAME session so the
    // cloud's idempotent fast-path returns the stored run.
    expect(calls.create).toHaveLength(1);
    expect(calls.finalize).toHaveLength(2);
    expect(calls.finalize[1]!.sessionId).toBe(FAKE_SESSION_ID);
    expect(first.reusedSession).toBe(false);
    expect(second.reusedSession).toBe(true);
    expect(second.cloudRunId).toBe(FAKE_RUN_ID);
  });

  it("stored session reaped server-side → mints a fresh session and retries once", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(
      join(runDir, "eval-session.json"),
      markerJson({ session_id: "ses_stale" }),
    );
    let finalizeCalls = 0;
    const { client, calls } = makeEvalClient({
      finalizeImpl: async (sessionId) => {
        finalizeCalls += 1;
        if (sessionId === "ses_stale") {
          throw new HostedOrchError("Session not found.", "req_x", 404);
        }
        return {
          run_id: FAKE_RUN_ID,
          score: 100,
          judge_model: "test-judge",
          dashboard_url: `https://dashboard.example.com/runs/${FAKE_RUN_ID}`,
        };
      },
    });
    mockPutFetch();

    const result = await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    expect(finalizeCalls).toBe(2);
    expect(calls.create).toHaveLength(1);
    expect(result.reusedSession).toBe(false);
    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    // Marker rewritten with the fresh session id.
    const marker = JSON.parse(
      await readFile(join(runDir, "eval-session.json"), "utf8"),
    );
    expect(marker.session_id).toBe(FAKE_SESSION_ID);
  });

  it("stored session for a DIFFERENT api url is ignored (fresh mint)", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(
      join(runDir, "eval-session.json"),
      markerJson({
        session_id: "ses_other_plane",
        api_url: "http://other-cloud.invalid",
      }),
    );
    const { client, calls } = makeEvalClient();
    mockPutFetch();

    await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    expect(calls.create).toHaveLength(1);
    expect(calls.finalize[0]!.sessionId).toBe(FAKE_SESSION_ID);
  });

  it("auth errors from finalize propagate untouched (no blind retry)", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(
      join(runDir, "eval-session.json"),
      markerJson({ session_id: "ses_stale" }),
    );
    const { client, calls } = makeEvalClient({
      finalizeImpl: async () => {
        throw new HostedAuthError("invalid api key");
      },
    });
    mockPutFetch();

    await expect(
      runEval({
        runDir,
        agent: "triage-bot",
        hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_bad" },
        client,
        projectConfig: null,
      }),
    ).rejects.toThrow(/invalid api key/);
    expect(calls.create).toHaveLength(0);
  });

  it("redacts secrets in uploaded blobs (hand-assembled run dirs)", async () => {
    const runDir = await writeRunDir(tmp, {
      eventsJsonl:
        JSON.stringify({
          kind: "TwinHttpEvent",
          event_id: "req_1",
          api_key: "redaction_fixture_secret_events",
        }) + "\n",
    });
    await writeFile(
      join(runDir, "state_initial.json"),
      JSON.stringify({ token: "redaction_fixture_secret_state" }),
    );

    const bodies: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if ((init as RequestInit | undefined)?.method === "PUT") {
        bodies[urlStr] = await new Request(urlStr, init as RequestInit).text();
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch call to ${urlStr}`);
    });

    const { client } = makeEvalClient();
    await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    expect(bodies[EVENTS_URL]).toContain("[REDACTED]");
    expect(bodies[EVENTS_URL]).not.toContain("redaction_fixture_secret_events");
    expect(bodies[STATE_INITIAL_URL]).not.toContain(
      "redaction_fixture_secret_state",
    );
  });
});

describe("pome eval review fixes (FDRS-656 follow-up)", () => {
  let tmp: string;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-eval-review-"));
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
    await rm(tmp, { recursive: true, force: true });
  });

  it("transient 502 on a reused session surfaces — no silent re-mint/re-judge", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(join(runDir, "eval-session.json"), markerJson());
    const { client, calls } = makeEvalClient({
      finalizeImpl: async () => {
        throw new HostedOrchError("bad gateway", "req_y", 502);
      },
    });
    mockPutFetch();

    await expect(
      runEval({
        runDir,
        agent: "triage-bot",
        hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
        client,
        projectConfig: null,
      }),
    ).rejects.toThrow(/bad gateway/);
    // The stored session must NOT be replaced: no fresh mint, one finalize.
    expect(calls.create).toHaveLength(0);
    expect(calls.finalize).toHaveLength(1);
  });

  it("marker minted for a different agent/task is invalidated (fresh mint)", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(
      join(runDir, "eval-session.json"),
      markerJson({ session_id: "ses_old_identity", agent: "other-bot" }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, calls } = makeEvalClient();
    mockPutFetch();

    const result = await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    expect(calls.create).toHaveLength(1);
    expect(calls.finalize[0]!.sessionId).toBe(FAKE_SESSION_ID);
    expect(result.reusedSession).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("different agent/task/api-url"),
    );
    // Marker rewritten with the current identity.
    const marker = JSON.parse(
      await readFile(join(runDir, "eval-session.json"), "utf8"),
    );
    expect(marker.agent).toBe("triage-bot");
    expect(marker.task_name).toBe("01-bug-happy-path");
  });

  it("marker with a changed --task is invalidated (fresh mint)", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(join(runDir, "eval-session.json"), markerJson());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, calls } = makeEvalClient();
    mockPutFetch();

    await runEval({
      runDir,
      agent: "triage-bot",
      task: "renamed-task",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    expect(calls.create).toEqual([
      { agent: "triage-bot", taskName: "renamed-task" },
    ]);
  });

  it("marker missing api_url is treated as non-matching (fresh mint)", async () => {
    const runDir = await writeRunDir(tmp);
    const marker = JSON.parse(markerJson()) as Record<string, unknown>;
    delete marker.api_url;
    await writeFile(join(runDir, "eval-session.json"), JSON.stringify(marker));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, calls } = makeEvalClient();
    mockPutFetch();

    await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    expect(calls.create).toHaveLength(1);
  });

  it("api_url trailing-slash difference still matches the stored session", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(
      join(runDir, "eval-session.json"),
      markerJson({ api_url: "http://no-cloud.invalid/" }),
    );
    const { client, calls } = makeEvalClient();
    mockPutFetch();

    const result = await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    expect(calls.create).toHaveLength(0);
    expect(result.reusedSession).toBe(true);
  });

  it("UNEVAL verdict (all criteria skipped) exits 1 even at score 100", async () => {
    const runDir = await writeRunDir(tmp);
    const { client } = makeEvalClient({
      finalizeImpl: async () => ({
        run_id: FAKE_RUN_ID,
        score: 100,
        judge_model: "test-judge",
        dashboard_url: `https://dashboard.example.com/runs/${FAKE_RUN_ID}`,
        criteria_results: [
          {
            criterion: { type: "P", text: "agent acted reasonably" },
            outcome: "skipped",
            passed: false,
            skipped: true,
            reason: "no judge configured",
          },
        ],
      }),
    });
    mockPutFetch();

    const result = await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    // A5 guard: nothing was actually evaluated — cannot exit 0.
    expect(result.score.evaluated).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("read-only run dir: verdict still returned; no score.json written", async () => {
    const runDir = await writeRunDir(tmp);
    await writeFile(join(runDir, "eval-session.json"), markerJson());
    const { client } = makeEvalClient();
    mockPutFetch();

    await chmod(runDir, 0o555);
    try {
      const result = await runEval({
        runDir,
        agent: "triage-bot",
        hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
        client,
        projectConfig: null,
      });
      // Verdict is returned for terminal display...
      expect(result.score.satisfaction).toBe(100);
      expect(result.exitCode).toBe(0);
      // ...and nothing is persisted (capture-only; no score.json ever).
      expect(existsSync(join(runDir, "score.json"))).toBe(false);
    } finally {
      await chmod(runDir, 0o755);
    }
  });

  it("config discovered from cwd when the run dir is outside the project", async () => {
    const projectDir = join(tmp, "project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "pome.config.json"),
      JSON.stringify({ agentSlug: "cfg-bot" }),
    );
    const externalRoot = join(tmp, "external");
    await mkdir(externalRoot, { recursive: true });
    const runDir = await writeRunDir(externalRoot);
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    const { client, calls } = makeEvalClient();
    mockPutFetch();

    await runEval({
      runDir,
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      // no projectConfig injection — exercise discovery
    });

    expect(calls.create).toEqual([
      { agent: "cfg-bot", taskName: "01-bug-happy-path" },
    ]);
  });

  it("corrupt pome.config.json → named usage error", async () => {
    const projectDir = join(tmp, "project-corrupt");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "pome.config.json"), "{nope");
    const runDir = await writeRunDir(projectDir);
    const { client } = makeEvalClient();
    mockPutFetch();

    const err = await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HostedUsageError);
    expect((err as Error).message).toContain("pome.config.json is corrupt");
  });

  it("meta exit_code accepts integer-like strings; unknown sends -1, never 0", async () => {
    const stringExitDir = await writeRunDir(tmp, {
      meta: { ...META, exit_code: "2" },
    });
    const { client: c1, calls: calls1 } = makeEvalClient();
    mockPutFetch();
    await runEval({
      runDir: stringExitDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client: c1,
      projectConfig: null,
    });
    expect(calls1.finalize[0]!.input.exitCode).toBe(2);

    const unknownExitRoot = join(tmp, "unknown-exit");
    await mkdir(unknownExitRoot, { recursive: true });
    const unknownExitDir = await writeRunDir(unknownExitRoot, {
      meta: { ...META, exit_code: "not-a-number" },
    });
    const { client: c2, calls: calls2 } = makeEvalClient();
    await runEval({
      runDir: unknownExitDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client: c2,
      projectConfig: null,
    });
    expect(calls2.finalize[0]!.input.exitCode).toBe(-1);
  });

  it("legacy event rows (no kind) are wrapped to TwinHttpEvent before upload", async () => {
    const legacyRow = JSON.stringify({
      ts: "2026-06-30T10:00:02.000Z",
      run_id: "ses_original_run",
      twin: "github",
      request_id: "req_legacy",
      method: "GET",
      path: "/repos/acme/api",
      status: 200,
    });
    const runDir = await writeRunDir(tmp, { eventsJsonl: `${legacyRow}\n` });

    const bodies: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if ((init as RequestInit | undefined)?.method === "PUT") {
        bodies[urlStr] = await new Request(urlStr, init as RequestInit).text();
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch call to ${urlStr}`);
    });
    const { client } = makeEvalClient();

    await runEval({
      runDir,
      agent: "triage-bot",
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
      projectConfig: null,
    });

    const uploaded = JSON.parse(bodies[EVENTS_URL]!.trimEnd());
    expect(uploaded.kind).toBe("TwinHttpEvent");
    expect(uploaded.event_id).toBe("req_legacy");
  });

  it("corrupt latest.json → named usage error with exit 5", async () => {
    const artifactsDir = join(tmp, "runs-corrupt");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "latest.json"), "{corrupt");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runEvalCommand(undefined, {
      artifactsDir,
      apiUrl: "http://no-cloud.invalid",
    });

    expect(process.exitCode).toBe(5);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("latest.json is corrupt"),
    );
  });

  it("latest.json without run_dir → usage error with exit 5", async () => {
    const artifactsDir = join(tmp, "runs-no-dir");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "latest.json"), JSON.stringify({ run_id: "x" }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runEvalCommand(undefined, {
      artifactsDir,
      apiUrl: "http://no-cloud.invalid",
    });

    expect(process.exitCode).toBe(5);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("has no run_dir field"),
    );
  });
});
