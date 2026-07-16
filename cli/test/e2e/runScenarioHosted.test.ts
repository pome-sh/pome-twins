import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { sign as signJwt } from "hono/jwt";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "../../src/cli/main.ts");
// Absolute loader path: child cwd is a temp dir without node_modules/tsx.
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const TWIN_AUTH_SECRET = "test-secret-32-chars-minimum-length";

let cloudServer: ServerType | undefined;
let receivedResult: unknown = null;
let finalizeResponseOverrides: Record<string, unknown> = {};
// F-768 — what `GET /_pome/events` serves. Default empty (the trivially-passing
// tests); the hosted-signals-lane test seeds a real twin event so the
// "not merged into events.jsonl" assertion has real content to exclude against.
let eventsResponse: unknown[] = [];
// F-768 — decompressed bodies the CLI PUT to the signed upload URLs, keyed by
// blob kind ("events" / "signals"). The fake cloud gunzips on receipt (uploads
// carry `content-encoding: gzip`).
let uploadedBlobs: Record<string, string> = {};

async function startFakeCloud(): Promise<number> {
  const app = new Hono();
  let port = 0;
  app.post("/v1/sessions", async (c) => {
    const sid = "ses_e2e";
    const token = await signJwt(
      { sid, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) + 600 },
      TWIN_AUTH_SECRET
    );
    return c.json({
      session_id: sid,
      session_token: "pst_test_e2e",
      twin_url: `http://127.0.0.1:${port}/s/${sid}`,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      agent_token: token,
      openapi_url: `http://127.0.0.1:${port}/openapi.json`,
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
          labels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
          issues: [{ number: 1, title: "x", labels: [{ name: "bug" }], assignee_login: null }],
        },
      ],
    })
  );
  app.get("/s/:sid/_pome/events", (c) => c.json(eventsResponse));
  // F-768 — mint signed upload URLs that point back at this fake cloud's PUT
  // sink so the runner's real upload lane (redact → gzip → PUT → thread key
  // onto /finalize) executes end to end. events.jsonl and signals.jsonl are
  // deliberately separate blobs under separate keys — the runner never merges
  // adapter signals into the trace on the hosted path.
  app.post("/v1/sessions/:id/result-upload-url", (c) =>
    c.json({
      url: `http://127.0.0.1:${port}/_upload/events`,
      key: `team-tm_test/session-${c.req.param("id")}/events.jsonl`,
    }),
  );
  app.post("/v1/sessions/:id/signals-upload-url", (c) =>
    c.json({
      url: `http://127.0.0.1:${port}/_upload/signals`,
      key: `team-tm_test/session-${c.req.param("id")}/signals.jsonl`,
    }),
  );
  app.put("/_upload/:kind", async (c) => {
    const gz = Buffer.from(await c.req.arrayBuffer());
    uploadedBlobs[c.req.param("kind")] = gunzipSync(gz).toString("utf8");
    return c.body(null, 200);
  });
  app.post("/v1/sessions/:id/finalize", async (c) => {
    receivedResult = await c.req.json();
    return c.json(
      {
        run_id: "run_e2e",
        score: 100,
        judge_model: "test-judge",
        dashboard_url: "http://127.0.0.1/runs/run_e2e",
        ...finalizeResponseOverrides,
      },
      201,
    );
  });
  app.delete("/v1/sessions/:id", (c) =>
    c.json({ id: c.req.param("id"), state: "expired" })
  );

  port = await new Promise<number>((res) => {
    cloudServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      res(info.port)
    );
  });
  return port;
}

describe("pome run --hosted (e2e via spawn)", () => {
  let tmp: string;
  let port: number;

  beforeEach(async () => {
    receivedResult = null;
    finalizeResponseOverrides = {};
    eventsResponse = [];
    uploadedBlobs = {};
    tmp = await mkdtemp(join(tmpdir(), "pome-e2e-"));
    // FDRS-641 — `pome run` gates on the doctor preflight (config present,
    // routing wired, egress floor; local twin boot is skipped on hosted
    // runs). Make tmp a wired repo and spawn the CLI from it, matching what
    // a real post-`pome install` project looks like.
    await writeFile(
      join(tmp, "pome.config.json"),
      JSON.stringify({ agent: { command: "true" } }, null, 2),
      "utf8"
    );
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(
      join(tmp, "src", "agent.ts"),
      "const baseUrl = process.env.POME_GITHUB_REST_URL;\nexport { baseUrl };\n",
      "utf8"
    );
    port = await startFakeCloud();
  });

  afterEach(async () => {
    cloudServer?.close();
    cloudServer = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it("exits 0, prints PASS + cloud dashboard URL, and never POSTs agent_stdout", async () => {
    const scenarioPath = join(tmp, "scn.md");
    // Trivially-passing scenario: 'no unsupported endpoint' + 'no new labels'
    // are true given empty events + identical state from the fake cloud.
    await writeFile(
      scenarioPath,
      [
        "# Trivial",
        "",
        "## Prompt",
        "Pretend prompt.",
        "",
        "## Success Criteria",
        "- [code] No unsupported endpoint was called",
        "- [code] No new labels were created",
        "",
        "## Config",
        "```yaml",
        "twins: [github]",
        "timeout: 30",
        "passThreshold: 100",
        "```",
        "",
      ].join("\n"),
      "utf8"
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_ENTRY,
        "run",
        scenarioPath,
        "--hosted",
        "--api-url",
        `http://127.0.0.1:${port}`,
        "--agent",
        "true",
        "--artifacts-dir",
        join(tmp, "runs"),
      ],
      {
        cwd: tmp,
        env: { ...process.env, POME_API_KEY: "pme_e2e_test" },
      }
    );

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdout.on("data", (d) => (stdout += d.toString()));
    const code = await new Promise<number>((res) => child.on("close", res));

    expect(code, `stderr was:\n${stderr}\nstdout was:\n${stdout}`).toBe(0);
    expect(stderr).toMatch(/PASS/);
    expect(stderr).toMatch(/cloud:\s+http/);

    // BYOK guard: agent_stdout never crosses the wire.
    expect(receivedResult).not.toBeNull();
    expect(receivedResult as Record<string, unknown>).not.toHaveProperty(
      "agent_stdout"
    );
  }, 90_000);

  it("prints UNEVAL when cloud score is 100 but returned criteria were skipped", async () => {
    finalizeResponseOverrides = {
      criteria_results: [
        {
          criterion: { type: "D", text: "No unsupported endpoint was called" },
          outcome: "skipped",
          passed: false,
          skipped: true,
          reason: "cloud could not evaluate this criterion",
        },
      ],
    };
    const scenarioPath = join(tmp, "scn.md");
    await writeFile(
      scenarioPath,
      [
        "# Trivial",
        "",
        "## Prompt",
        "Pretend prompt.",
        "",
        "## Success Criteria",
        "- [code] No unsupported endpoint was called",
        "",
        "## Config",
        "```yaml",
        "twins: [github]",
        "timeout: 30",
        "passThreshold: 100",
        "```",
        "",
      ].join("\n"),
      "utf8",
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_ENTRY,
        "run",
        scenarioPath,
        "--api-url",
        `http://127.0.0.1:${port}`,
        "--agent",
        "true",
        "--artifacts-dir",
        join(tmp, "runs"),
      ],
      {
        cwd: tmp,
        env: { ...process.env, POME_API_KEY: "pme_e2e_test" },
      },
    );

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const code = await new Promise<number>((res) => child.on("close", res));

    expect(code, `stderr was:\n${stderr}`).toBe(0);
    expect(stderr).toMatch(/UNEVAL Trivial/);
    expect(stderr).toContain("score: un-evaluated (cannot pass)");
    expect(stderr).toContain("cloud score: 100/100");
  }, 90_000);

  // F-768 (M1 "Turn-usage into the main ledger") — the whole point of the
  // LlmTurnEvent contract is that per-turn LLM usage, and specifically the
  // cache-read/cache-creation token counts, reaches cloud. On the HOSTED lane
  // that means the adapter's signals JSONL survives the runner's redact → gzip
  // → PUT pipeline as its own `signals.jsonl` blob and its key is threaded onto
  // /finalize — the runner never merges signals into the trace's events.jsonl.
  // This drives one real `pome run --hosted` command and inspects the bytes the
  // fake cloud actually received.
  it("uploads LlmTurnEvent rows (cache tokens intact) as a separate signals.jsonl blob, threads signalsStorageKey to finalize, and never merges them into events.jsonl", async () => {
    // A real twin HTTP event so the uploaded events.jsonl has genuine content
    // to prove the turn rows are NOT merged into it.
    eventsResponse = [
      {
        ts: "2026-07-15T18:00:01.000Z",
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
    ];

    // Two per-turn usage rows the CAS adapter emits into the signals JSONL —
    // one 0-based turn each, carrying the cache-read/cache-creation counts that
    // no other event kind reaches cloud with.
    const turnRows = [
      {
        kind: "LlmTurnEvent",
        ts: "2026-07-15T18:00:00.000Z",
        event_id: "turn_0",
        parent_id: null,
        turn_index: 0,
        model: "claude-opus-4-8",
        input_tokens: 1200,
        output_tokens: 350,
        cache_read_input_tokens: 8192,
        cache_creation_input_tokens: 4096,
        finish_reasons: ["end_turn"],
        latency_ms: 4200,
        latency_ms_estimated: true,
        session_id: null,
      },
      {
        kind: "LlmTurnEvent",
        ts: "2026-07-15T18:00:05.000Z",
        event_id: "turn_1",
        parent_id: null,
        turn_index: 1,
        model: "claude-opus-4-8",
        input_tokens: 640,
        output_tokens: 120,
        cache_read_input_tokens: 12288,
        cache_creation_input_tokens: 0,
        finish_reasons: ["end_turn"],
        latency_ms: 900,
        latency_ms_estimated: true,
        session_id: null,
      },
    ];

    // Stub agent: append the turn rows to the signals file the runner injects
    // via POME_ADAPTER_SIGNALS_PATH — exactly where the real adapter writes.
    const agentScript = join(tmp, "emit-turns.mjs");
    await writeFile(
      agentScript,
      [
        'import { appendFileSync } from "node:fs";',
        `const rows = ${JSON.stringify(turnRows)};`,
        "const path = process.env.POME_ADAPTER_SIGNALS_PATH;",
        'for (const r of rows) appendFileSync(path, JSON.stringify(r) + "\\n");',
        "",
      ].join("\n"),
      "utf8",
    );

    const scenarioPath = join(tmp, "scn.md");
    await writeFile(
      scenarioPath,
      [
        "# Trivial",
        "",
        "## Prompt",
        "Pretend prompt.",
        "",
        "## Success Criteria",
        "- [code] No unsupported endpoint was called",
        "- [code] No new labels were created",
        "",
        "## Config",
        "```yaml",
        "twins: [github]",
        "timeout: 30",
        "passThreshold: 100",
        "```",
        "",
      ].join("\n"),
      "utf8",
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_ENTRY,
        "run",
        scenarioPath,
        "--hosted",
        "--api-url",
        `http://127.0.0.1:${port}`,
        "--agent",
        `node "${agentScript}"`,
        "--artifacts-dir",
        join(tmp, "runs"),
      ],
      {
        cwd: tmp,
        env: { ...process.env, POME_API_KEY: "pme_e2e_test" },
      },
    );

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdout.on("data", (d) => (stdout += d.toString()));
    const code = await new Promise<number>((res) => child.on("close", res));

    // The run was accepted end to end: cloud finalized it and the CLI passed.
    expect(code, `stderr was:\n${stderr}\nstdout was:\n${stdout}`).toBe(0);
    expect(stderr).toMatch(/PASS/);

    // finalize received the signals storage key (no rejection).
    expect(receivedResult).not.toBeNull();
    expect(
      (receivedResult as Record<string, unknown>).signals_storage_key,
    ).toBe("team-tm_test/session-ses_e2e/signals.jsonl");

    // The uploaded signals blob carries the turn rows, cache token counts
    // intact after the redact + gzip round trip. Every row must parse (the
    // redactJsonl line filter must not have corrupted the JSONL) and be an
    // LlmTurnEvent. NOTE: runScenarioHosted runs the agent command twice — a
    // ≤10s preflight probe then the real run — against the same signals file,
    // so the fixture's two turns appear once per invocation; assert on the
    // distinct turns present, not an exact count.
    expect(uploadedBlobs.signals, "signals.jsonl was not uploaded").toBeDefined();
    const signalRows = uploadedBlobs.signals
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(signalRows.every((row) => row.kind === "LlmTurnEvent")).toBe(true);
    const turn0 = signalRows.find((row) => row.turn_index === 0);
    const turn1 = signalRows.find((row) => row.turn_index === 1);
    expect(turn0, "turn_index 0 row missing from signals blob").toMatchObject({
      kind: "LlmTurnEvent",
      input_tokens: 1200,
      output_tokens: 350,
      cache_read_input_tokens: 8192,
      cache_creation_input_tokens: 4096,
    });
    expect(turn1, "turn_index 1 row missing from signals blob").toMatchObject({
      kind: "LlmTurnEvent",
      cache_read_input_tokens: 12288,
      cache_creation_input_tokens: 0,
    });

    // The turn rows live ONLY in signals.jsonl. The hosted lane uploads adapter
    // signals as a separate blob and never merges them into the trace, so
    // events.jsonl carries the twin HTTP event but no LlmTurnEvent.
    expect(uploadedBlobs.events, "events.jsonl was not uploaded").toBeDefined();
    expect(uploadedBlobs.events).toContain("TwinHttpEvent");
    expect(uploadedBlobs.events).toContain("/repos/acme/api");
    expect(uploadedBlobs.events).not.toContain("LlmTurnEvent");
  }, 90_000);
});
