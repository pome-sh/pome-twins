// SPDX-License-Identifier: Apache-2.0
// Unit tests for the events.jsonl upload orchestration in runScenarioHosted.
// Covers FDRS-357 Task 11: happy path, requestEventsUploadUrl throws, PUT 5xx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { runScenarioHosted } from "../../../src/runner/runScenarioHosted.js";
import type { HostedClient } from "../../../src/hosted/client.js";
import { HostedOrchError } from "../../../src/hosted/errors.js";
import type {
  CreateSessionResponse,
  FinalizeResponse,
  SessionPublic,
  SubmitResultResponse,
} from "../../../src/types/shared.js";

// Minimal passing scenario fixture that parseScenario can handle.
const TRIVIAL_PASSING_SCENARIO =
  "# Trivial\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [D] No unsupported endpoint was called\n";

const FAKE_SESSION_ID = "ses_upload_test";
const FAKE_RUN_ID = "run_upload_test";
const FAKE_UPLOAD_URL = "https://signed.example/put-events";
const FAKE_UPLOAD_KEY = "team-tm_x/session-ses_upload_test/events.jsonl";

// Blob uploads are gzip-encoded (WAF content-rule workaround); the fetch mock
// captures the raw gzipped body, so decompress before asserting on the text.
async function gunzipInitBody(init: RequestInit | undefined): Promise<string> {
  const body = (init as RequestInit).body as unknown as
    | Uint8Array
    | ArrayBuffer;
  return gunzipSync(Buffer.from(body as Uint8Array)).toString("utf8");
}

// The recorder event returned by fetchEvents — same shape as the integration
// test fixture so scoreAndWriteRun doesn't trip.
const FAKE_EVENT = {
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
};

const FAKE_STATE = {
  repositories: [{ owner: "acme", name: "api", full_name: "acme/api", labels: [], issues: [] }],
};

/**
 * Build a stub HostedClient with controllable requestEventsUploadUrl behavior.
 * finalize records what it was called with so we can assert on traceStorageKey.
 */
function makeStubClient({
  requestEventsUploadUrlImpl,
  requestStateUploadUrlImpl,
  requestSignalsUploadUrlImpl,
  requestMetaUploadUrlImpl,
  fetchStateImpl,
  finalizeScore = 100,
}: {
  requestEventsUploadUrlImpl: () => Promise<{ url: string; key: string }>;
  requestStateUploadUrlImpl?: () => Promise<{
    state_initial: { url: string; key: string };
    state_final: { url: string; key: string };
  }>;
  requestSignalsUploadUrlImpl?: () => Promise<{ url: string; key: string }>;
  requestMetaUploadUrlImpl?: () => Promise<{ url: string; key: string }>;
  fetchStateImpl?: () => Promise<unknown>;
  finalizeScore?: number;
}): {
  client: HostedClient;
  getFinalizeTraceStorageKey: () => string | undefined;
  getFinalizeStateKeys: () => {
    initial: string | undefined;
    final: string | undefined;
  };
  getFinalizeSignalsStorageKey: () => string | undefined;
  getFinalizeInput: () => unknown;
  getCreateSessionInput: () => unknown;
} {
  let finalizeInput: unknown;
  let createSessionInput: unknown;

  const client: HostedClient = {
    async createSession(input) {
      createSessionInput = input;
      return {
        session_id: FAKE_SESSION_ID,
        twin_url: "http://no-twin.invalid/s/ses_upload_test",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        agent_token: "tok_test",
        openapi_url: "http://no-twin.invalid/openapi.json",
        provider_credentials: {},
      } as CreateSessionResponse;
    },
    async createEvalSession() {
      // FDRS-656 — never reached by runScenarioHosted; eval-command tests
      // supply their own mock.
      throw new HostedOrchError("no eval-session stubbed");
    },
    async listSessions() {
      return [] as SessionPublic[];
    },
    async getSession() {
      return {} as SessionPublic;
    },
    fetchState: fetchStateImpl ?? (async () => FAKE_STATE),
    async fetchEvents() {
      return [FAKE_EVENT];
    },
    async finalize(_sessionId, input) {
      finalizeInput = input;
      return {
        run_id: FAKE_RUN_ID,
        score: finalizeScore,
        judge_model: "test-judge",
        dashboard_url: `https://dashboard.example.com/runs/${FAKE_RUN_ID}`,
      } satisfies FinalizeResponse;
    },
    async submitResult() {
      // Not called from runScenarioHosted any more; left as a stub to satisfy
      // the deprecated-but-still-exposed HostedClient surface.
      return {
        run_id: FAKE_RUN_ID,
        dashboard_url: `https://dashboard.example.com/runs/${FAKE_RUN_ID}`,
      } as SubmitResultResponse;
    },
    requestEventsUploadUrl: requestEventsUploadUrlImpl,
    requestStateUploadUrl:
      requestStateUploadUrlImpl ??
      (async () => {
        throw new HostedOrchError("no state-upload-url stubbed");
      }),
    requestSignalsUploadUrl:
      requestSignalsUploadUrlImpl ??
      // F0-4 / L7 — signals upload is per-run optional. Tests that don't
      // care about the signals path get an unreachable stub; the F0-4
      // suite supplies a real mock.
      (async () => {
        throw new HostedOrchError("no signals-upload-url stubbed");
      }),
    requestMetaUploadUrl:
      requestMetaUploadUrlImpl ??
      // D18.1 — best-effort like the other blobs; tests that don't care get
      // an unreachable stub that degrades to metaKey=null.
      (async () => {
        throw new HostedOrchError("no meta-upload-url stubbed");
      }),
    async abandonSession() {
      throw new HostedOrchError("no abandon stubbed (single-run path never calls it)");
    },
    async deleteSession() {
      // no-op
    },
  };

  return {
    client,
    getFinalizeTraceStorageKey: () =>
      (finalizeInput as { traceStorageKey?: string } | undefined)
        ?.traceStorageKey,
    getFinalizeStateKeys: () => ({
      initial: (
        finalizeInput as { stateInitialStorageKey?: string } | undefined
      )?.stateInitialStorageKey,
      final: (
        finalizeInput as { stateFinalStorageKey?: string } | undefined
      )?.stateFinalStorageKey,
    }),
    getFinalizeSignalsStorageKey: () =>
      (finalizeInput as { signalsStorageKey?: string } | undefined)
        ?.signalsStorageKey,
    getFinalizeInput: () => finalizeInput,
    getCreateSessionInput: () => createSessionInput,
  };
}

describe("runScenarioHosted events.jsonl upload orchestration (FDRS-357)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-upload-test-"));
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  // F0-4 / L7 — when the agent emits adapter signals (HookEvent /
  // ToolUseEvent / SubagentSpawnEvent rows), the runner uploads
  // signals.jsonl to the cloud and threads `signalsStorageKey` onto the
  // /finalize call so the server-side correlator switches to
  // `correlateTraceJsonlWithSignals`. Empty signals files skip the upload
  // entirely (covered by every other happy-path test in this suite).
  it("F0-4: uploads signals.jsonl and forwards signalsStorageKey to finalize when agent emits signals", async () => {
    const SIGNALS_URL = "https://signed.example/put-signals";
    const SIGNALS_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/signals.jsonl`;

    let signalsPutBody: string | null = null;
    let signalsPutCount = 0;
    let eventsPutCount = 0;

    const { client, getFinalizeSignalsStorageKey } = makeStubClient({
      requestEventsUploadUrlImpl: async () => ({
        url: FAKE_UPLOAD_URL,
        key: FAKE_UPLOAD_KEY,
      }),
      requestSignalsUploadUrlImpl: async () => ({
        url: SIGNALS_URL,
        key: SIGNALS_KEY,
      }),
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const method = (init as RequestInit | undefined)?.method;
      if (urlStr === FAKE_UPLOAD_URL && method === "PUT") {
        eventsPutCount += 1;
        return new Response(null, { status: 200 });
      }
      if (urlStr === SIGNALS_URL && method === "PUT") {
        signalsPutCount += 1;
        signalsPutBody = await gunzipInitBody(init as RequestInit);
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch call to ${urlStr}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");
    // Stub agent writes a single fake HookEvent to the signals path the
    // runner injected via POME_ADAPTER_SIGNALS_PATH. JSON-stringify so
    // path escaping works on Windows too.
    const stubSignal =
      '{"kind":"HookEvent","event_id":"hk_1","ts":"2026-05-27T18:00:00.000Z","token":"redaction_fixture_secret_signal"}';
    const agentScript = `require('fs').appendFileSync(process.env.POME_ADAPTER_SIGNALS_PATH, ${JSON.stringify(`${stubSignal}\n`)}); console.log('ok');`;
    const stubAgent = `node -e ${JSON.stringify(agentScript)}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: stubAgent,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    expect(eventsPutCount).toBe(1);
    expect(signalsPutCount).toBe(1);
    expect(signalsPutBody).toContain('"kind":"HookEvent"');
    expect(signalsPutBody).toContain("[REDACTED]");
    expect(signalsPutBody).not.toContain("redaction_fixture_secret_signal");
    expect(getFinalizeSignalsStorageKey()).toBe(SIGNALS_KEY);
  });

  // D18.1 / D18.6 — when the control plane exposes the meta-upload-url route,
  // the runner reads the on-disk meta.json (written by writeRunArtifactsCore
  // with spec_version + twin_versions) and PUTs it to the signed URL. The key
  // is NOT threaded onto /finalize — cloud auto-discovers meta.json at the
  // conventional session-prefixed path. This test locks the happy path so a
  // regression in the meta read/upload wiring (wrong file path, missing blob)
  // is caught above the lower-level uploadAndFinalize.test.ts.
  it("D18.1: uploads meta.json with spec_version to the signed URL when the route exists", async () => {
    const META_URL = "https://signed.example/put-meta";
    const META_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/meta.json`;

    let metaPutBody: string | null = null;
    let metaPutCount = 0;

    const { client, getFinalizeInput } = makeStubClient({
      requestEventsUploadUrlImpl: async () => ({
        url: FAKE_UPLOAD_URL,
        key: FAKE_UPLOAD_KEY,
      }),
      requestMetaUploadUrlImpl: async () => ({ url: META_URL, key: META_KEY }),
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const method = (init as RequestInit | undefined)?.method;
      if (urlStr === FAKE_UPLOAD_URL && method === "PUT") {
        return new Response(null, { status: 200 });
      }
      if (urlStr === META_URL && method === "PUT") {
        metaPutCount += 1;
        metaPutBody = await gunzipInitBody(init as RequestInit);
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch call to ${urlStr}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");
    const stubAgent = `node -e ${JSON.stringify("console.log('done')")}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: stubAgent,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    // meta.json was PUT exactly once, and its body carries the D18.1 contract.
    expect(metaPutCount).toBe(1);
    expect(metaPutBody).not.toBeNull();
    const parsedMeta = JSON.parse(metaPutBody as unknown as string);
    expect(parsedMeta.spec_version).toBe(1);
    expect(parsedMeta.twin_versions).toBeDefined();
    // The meta key is deliberately NOT threaded onto /finalize — cloud
    // auto-discovers it at the conventional path.
    expect(
      (getFinalizeInput() as { metaStorageKey?: string }).metaStorageKey,
    ).toBeUndefined();
  });

  it("happy path: PUTs events JSONL to signed URL and forwards storage key to finalize", async () => {
    // Capture the PUT request body sent to the signed upload URL.
    let capturedPutBody: string | null = null;
    let putCallCount = 0;

    const { client, getFinalizeTraceStorageKey } = makeStubClient({
      requestEventsUploadUrlImpl: async () => ({
        url: FAKE_UPLOAD_URL,
        key: FAKE_UPLOAD_KEY,
      }),
    });

    // Stub globalThis.fetch to intercept the PUT to the signed URL.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if (urlStr === FAKE_UPLOAD_URL && (init as RequestInit | undefined)?.method === "PUT") {
        putCallCount += 1;
        capturedPutBody = await gunzipInitBody(init as RequestInit);
        return new Response(null, { status: 200 });
      }
      // Unexpected call — fail visibly.
      throw new Error(`Unexpected fetch call to ${urlStr}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");
    const stubAgent = `node -e ${JSON.stringify("console.log('done')")}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: stubAgent,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    // Run must complete and return the cloud run id.
    expect(result.cloudRunId).toBe(FAKE_RUN_ID);

    // PUT must have been called exactly once.
    expect(putCallCount).toBe(1);

    // The PUT body must be a valid JSONL containing our fake event.
    expect(capturedPutBody).not.toBeNull();
    const lines = (capturedPutBody as unknown as string).trimEnd().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsedEvent = JSON.parse(lines[0]!);
    expect(parsedEvent.method).toBe("GET");
    expect(parsedEvent.path).toBe("/repos/acme/api");

    // finalize must receive the storage key as traceStorageKey.
    expect(getFinalizeTraceStorageKey()).toBe(FAKE_UPLOAD_KEY);
  });

  it("state upload happy path: PUTs both state blobs and forwards both keys to finalize (FDRS-395)", async () => {
    const STATE_INITIAL_URL = "https://signed.example/put-state-initial";
    const STATE_FINAL_URL = "https://signed.example/put-state-final";
    const STATE_INITIAL_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/state_initial.json`;
    const STATE_FINAL_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/state_final.json`;

    let stateInitialBody: string | null = null;
    let stateFinalBody: string | null = null;

    const { client, getFinalizeStateKeys } = makeStubClient({
      requestEventsUploadUrlImpl: async () => ({
        url: FAKE_UPLOAD_URL,
        key: FAKE_UPLOAD_KEY,
      }),
      requestStateUploadUrlImpl: async () => ({
        state_initial: { url: STATE_INITIAL_URL, key: STATE_INITIAL_KEY },
        state_final: { url: STATE_FINAL_URL, key: STATE_FINAL_KEY },
      }),
      fetchStateImpl: async () => ({
        ...FAKE_STATE,
        api_key: "redaction_fixture_secret_state_key",
        nested: { session_token: "redaction_fixture_secret_state_session" },
      }),
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const method = (init as RequestInit | undefined)?.method;
      if (urlStr === FAKE_UPLOAD_URL && method === "PUT") {
        return new Response(null, { status: 200 });
      }
      if (urlStr === STATE_INITIAL_URL && method === "PUT") {
        stateInitialBody = await gunzipInitBody(init as RequestInit);
        return new Response(null, { status: 200 });
      }
      if (urlStr === STATE_FINAL_URL && method === "PUT") {
        stateFinalBody = await gunzipInitBody(init as RequestInit);
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch call to ${urlStr}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");
    const stubAgent = `node -e ${JSON.stringify("console.log('done')")}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: stubAgent,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    expect(getFinalizeStateKeys()).toEqual({
      initial: STATE_INITIAL_KEY,
      final: STATE_FINAL_KEY,
    });
    expect(stateInitialBody).not.toBeNull();
    expect(stateFinalBody).not.toBeNull();
    // Both blobs should be JSON-parseable redacted copies of the twin's exported state
    // (same fixture for stateInitial and stateFinal in this stub).
    const parsedInitial = JSON.parse(stateInitialBody as unknown as string);
    const parsedFinal = JSON.parse(stateFinalBody as unknown as string);
    expect(parsedInitial.api_key).toBe("[REDACTED]");
    expect(parsedInitial.nested.session_token).toBe("[REDACTED]");
    expect(parsedFinal.api_key).toBe("[REDACTED]");
    expect(parsedFinal.nested.session_token).toBe("[REDACTED]");
    expect(stateInitialBody).not.toContain("redaction_fixture_secret_state_key");
    expect(stateFinalBody).not.toContain("redaction_fixture_secret_state_session");
  });

  it("requestStateUploadUrl throws (e.g. 404): finalize gets no state keys and run completes (FDRS-395)", async () => {
    const { client, getFinalizeStateKeys } = makeStubClient({
      requestEventsUploadUrlImpl: async () => {
        throw new HostedOrchError("no route");
      },
      requestStateUploadUrlImpl: async () => {
        throw new HostedOrchError("no route");
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      throw new Error(`Unexpected fetch call to ${String(url)}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: `node -e ${JSON.stringify("console.log('done')")}`,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    expect(getFinalizeStateKeys()).toEqual({
      initial: undefined,
      final: undefined,
    });
  });

  it("state PUT 503 on one of the pair: forwards the surviving key, omits the failed one (FDRS-395)", async () => {
    const STATE_INITIAL_URL = "https://signed.example/put-state-initial";
    const STATE_FINAL_URL = "https://signed.example/put-state-final";
    const STATE_INITIAL_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/state_initial.json`;
    const STATE_FINAL_KEY = `team-tm_x/session-${FAKE_SESSION_ID}/state_final.json`;

    const { client, getFinalizeStateKeys } = makeStubClient({
      requestEventsUploadUrlImpl: async () => {
        throw new HostedOrchError("no route");
      },
      requestStateUploadUrlImpl: async () => ({
        state_initial: { url: STATE_INITIAL_URL, key: STATE_INITIAL_KEY },
        state_final: { url: STATE_FINAL_URL, key: STATE_FINAL_KEY },
      }),
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const method = (init as RequestInit | undefined)?.method;
      if (urlStr === STATE_INITIAL_URL && method === "PUT") {
        return new Response(null, { status: 200 });
      }
      if (urlStr === STATE_FINAL_URL && method === "PUT") {
        return new Response("upstream error", { status: 503 });
      }
      throw new Error(`Unexpected fetch call to ${urlStr}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: `node -e ${JSON.stringify("console.log('done')")}`,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    expect(getFinalizeStateKeys()).toEqual({
      initial: STATE_INITIAL_KEY,
      final: undefined,
    });
  });

  it("requestEventsUploadUrl throws (e.g. 404): finalize gets no traceStorageKey override and run completes", async () => {
    const { client, getFinalizeTraceStorageKey } = makeStubClient({
      requestEventsUploadUrlImpl: async () => {
        throw new HostedOrchError("no route");
      },
    });

    // fetch should NOT be called for the PUT in this branch.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      throw new Error(`Unexpected fetch call to ${String(url)}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");
    const stubAgent = `node -e ${JSON.stringify("console.log('done')")}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: stubAgent,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    // Run must still complete.
    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    // finalize must receive undefined (cloud falls back to conventional key).
    expect(getFinalizeTraceStorageKey()).toBeUndefined();
    // The unexpected-fetch spy must not have fired.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("PUT to storage returns 503: finalize gets no traceStorageKey override and run completes", async () => {
    const { client, getFinalizeTraceStorageKey } = makeStubClient({
      requestEventsUploadUrlImpl: async () => ({
        url: FAKE_UPLOAD_URL,
        key: FAKE_UPLOAD_KEY,
      }),
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if (urlStr === FAKE_UPLOAD_URL && (init as RequestInit | undefined)?.method === "PUT") {
        return new Response("upstream error", { status: 503 });
      }
      throw new Error(`Unexpected fetch call to ${urlStr}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");
    const stubAgent = `node -e ${JSON.stringify("console.log('done')")}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: stubAgent,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    // Run must still complete.
    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
    // finalize must receive undefined (PUT failed → no override).
    expect(getFinalizeTraceStorageKey()).toBeUndefined();
  });

  it("forwards the resolved seed from a sidecar to createSession.seed", async () => {
    const { client, getCreateSessionInput } = makeStubClient({
      requestEventsUploadUrlImpl: async () => {
        throw new HostedOrchError("no route");
      },
    });

    // Scenario uses a prose ## Seed State section (the post-2026-05-22 shape)
    // with a sibling .seed.json sidecar. Without forwarding, cloud would 422
    // trying to extract JSON from the prose markdown.
    const scenarioPath = join(tmp, "scn.md");
    const sidecarPath = join(tmp, "scn.seed.json");
    await writeFile(
      scenarioPath,
      "# Trivial\n\n## Prompt\np\n\n## Success Criteria\n- [D] No unsupported endpoint was called\n\n## Seed State\nA GitHub-shaped twin with one repo.\n",
      "utf8",
    );
    const sidecarSeed = {
      repositories: [
        { owner: "acme", name: "api", labels: [{ name: "bug" }] },
      ],
      _meta: { source_hash: "deadbeef" },
    };
    await writeFile(sidecarPath, JSON.stringify(sidecarSeed), "utf8");

    await runScenarioHosted({
      scenarioPath,
      agentCommand: `node -e ${JSON.stringify("console.log('done')")}`,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    const sent = getCreateSessionInput() as { seed?: unknown };
    expect(sent.seed).toBeDefined();
    // _meta is stripped by stripSidecarMeta before being handed to the schema;
    // the forwarded seed should match the schema-validated shape, not the raw
    // sidecar.
    expect(sent.seed).toMatchObject({
      repositories: [
        { owner: "acme", name: "api", labels: [{ name: "bug" }] },
      ],
    });
  });

  it("reads agentId and agent.sdk from the nearest pome.config.json", async () => {
    const { client, getCreateSessionInput } = makeStubClient({
      requestEventsUploadUrlImpl: async () => {
        throw new HostedOrchError("no route");
      },
    });

    const projectDir = join(tmp, "project");
    const scenarioDir = join(projectDir, "scenarios");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(scenarioDir, { recursive: true }),
    );
    await writeFile(
      join(projectDir, "pome.config.json"),
      JSON.stringify({
        agentId: "agt_registered",
        agent: { sdk: "claude-agent-sdk" },
      }),
    );
    const scenarioPath = join(scenarioDir, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");

    await runScenarioHosted({
      scenarioPath,
      agentCommand: `node -e ${JSON.stringify("console.log('done')")}`,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    expect(getCreateSessionInput()).toMatchObject({
      agentId: "agt_registered",
    });
  });
});

describe("runScenarioHosted ADR-013 score reporting", () => {
  let tmp: string;
  const SAVED_ENV: Record<string, string | undefined> = {};
  const LLM_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "POME_LLM_API_KEY"] as const;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-finalize-test-"));
    vi.restoreAllMocks();
    // The bug we're locking against: when no LLM key is present, the legacy
    // local-evaluator path produced a satisfaction < 100 (probabilistic skip)
    // that the CLI printed instead of cloud's authoritative score. With the
    // fix, the runner doesn't call the local evaluator at all, so the score
    // is whatever cloud returned.
    for (const k of LLM_KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const k of LLM_KEYS) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k];
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports cloud's satisfaction_score on PASS regardless of LLM-key absence (the regression this PR fixes)", async () => {
    // Scenario with a probabilistic criterion. Pre-fix, the local evaluator
    // would skip this criterion (no LLM key) and pull satisfaction below
    // the passThreshold (100). Post-fix, the local evaluator is never called
    // — cloud's score wins.
    const scenarioWithProbabilistic =
      "# Trivial P\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n" +
      "- [D] No unsupported endpoint was called\n" +
      "- [P] The agent followed expected behavior\n";

    const { client } = makeStubClient({
      requestEventsUploadUrlImpl: async () => {
        throw new HostedOrchError("no route");
      },
      finalizeScore: 100,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      throw new Error(`Unexpected fetch call to ${String(url)}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, scenarioWithProbabilistic, "utf8");
    const stubAgent = `node -e ${JSON.stringify("console.log('done')")}`;

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: stubAgent,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    // The CLI's printed `score:` line reads from result.score.satisfaction.
    // Cloud said 100; CLI must say 100.
    expect(result.score.satisfaction).toBe(100);
    expect(result.score.results).toEqual([]);
    // PASS gate: satisfaction >= passThreshold (default 100) ⇒ exitCode 0.
    expect(result.exitCode).toBe(0);
    expect(result.cloudRunId).toBe(FAKE_RUN_ID);
  });

  it("forwards scenario.criteria as criterion definitions (id/text/kind), not results", async () => {
    const scenarioWithBoth =
      "# Trivial mixed\n\n## Prompt\np\n\n## Success Criteria\n" +
      "- [D] Issue exists\n" +
      "- [P] Agent acted reasonably\n";

    const { client, getFinalizeInput } = makeStubClient({
      requestEventsUploadUrlImpl: async () => {
        throw new HostedOrchError("no route");
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      throw new Error(`Unexpected fetch call to ${String(url)}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, scenarioWithBoth, "utf8");

    await runScenarioHosted({
      scenarioPath,
      agentCommand: `node -e ${JSON.stringify("console.log('done')")}`,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    const sent = getFinalizeInput() as {
      criteria: { id: string; text: string; kind: string }[];
    };
    expect(sent.criteria).toEqual([
      { id: "crit_0", text: "Issue exists", kind: "D" },
      { id: "crit_1", text: "Agent acted reasonably", kind: "P" },
    ]);
  });

  it("FAIL when cloud returns satisfaction < passThreshold", async () => {
    const { client } = makeStubClient({
      requestEventsUploadUrlImpl: async () => {
        throw new HostedOrchError("no route");
      },
      finalizeScore: 75,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      throw new Error(`Unexpected fetch call to ${String(url)}`);
    });

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, TRIVIAL_PASSING_SCENARIO, "utf8");

    const result = await runScenarioHosted({
      scenarioPath,
      agentCommand: `node -e ${JSON.stringify("console.log('done')")}`,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: "http://no-cloud.invalid", apiKey: "pme_test" },
      client,
    });

    expect(result.score.satisfaction).toBe(75);
    // Default passThreshold is 100 ⇒ FAIL ⇒ exitCode 1.
    expect(result.exitCode).toBe(1);
  });
});
