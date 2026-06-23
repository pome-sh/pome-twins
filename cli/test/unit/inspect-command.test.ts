import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";

const originalCwd = process.cwd();

describe("pome inspect command", () => {
  let tmp: string;
  let runDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-inspect-cmd-"));
    runDir = join(tmp, "runs", "scenario-x", "run_abc");
    await mkdir(runDir, { recursive: true });
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it("exits with code 2 and prints the legacy message on a pre-FDRS-398 events.jsonl", async () => {
    const legacy = {
      ts: "2026-05-01T00:00:00.000Z",
      run_id: "run_old",
      twin: "github",
      request_id: "req_1",
      step_id: null,
      tool_call_id: null,
      method: "GET",
      path: "/repos/acme/api",
      request_body: null,
      status: 200,
      response_body: null,
      latency_ms: 3,
      fidelity: "semantic",
      state_mutation: false,
      state_delta: null,
      error: null,
    };
    await writeFile(join(runDir, "events.jsonl"), JSON.stringify(legacy) + "\n");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "pome", "inspect", runDir]);

    expect(process.exitCode).toBe(2);
    const errors = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain(
      "this run was produced by an older CLI version (pre-M0); rerun against current CLI to view",
    );
    // We must NOT render trace health or per-event sections before the
    // legacy error — those would be misleading on legacy data.
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toContain("Trace health");
    expect(out).not.toContain("Events");
  });

  it("renders trace health + events on the green path", async () => {
    await writeFile(
      join(runDir, "meta.json"),
      JSON.stringify({ run_id: "run_abc", scenario: "scenario-x", twins: ["github"] }),
    );
    const events = [
      {
        kind: "LlmCallEvent",
        ts: "2026-05-26T00:00:00.500Z",
        event_id: "evt_llm_1",
        parent_id: null,
        host: "api.anthropic.com",
        port: 443,
        latency_ms: 800,
        bytes_in: 100,
        bytes_out: 200,
        url: null,
        method: null,
        status: null,
        model: null,
        prompt_tokens: null,
        completion_tokens: null,
        cost_usd: null,
      },
      {
        kind: "TwinHttpEvent",
        ts: "2026-05-26T00:00:01.000Z",
        event_id: "evt_twin_1",
        parent_id: null,
        run_id: "run_abc",
        twin: "github",
        request_id: "req_1",
        step_id: null,
        tool_call_id: null,
        method: "GET",
        path: "/repos/acme/api",
        request_body: null,
        status: 200,
        response_body: null,
        latency_ms: 5,
        fidelity: "semantic",
        state_mutation: false,
        state_delta: null,
        error: null,
      },
    ];
    await writeFile(
      join(runDir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "pome", "inspect", runDir]);

    // No score.json was written — inspect must still succeed (hosted runs
    // upload events first; score lands after /finalize). Exit code stays
    // unset (treated as 0).
    expect(process.exitCode).toBeUndefined();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Trace health:");
    expect(out).toContain("proxy: 1/expected≥1");
    expect(out).toContain("twin: 1/expected≥1");
    expect(out).toContain("Events (2):");
    expect(out).toContain("Score: (score.json not found)");
  });
});
