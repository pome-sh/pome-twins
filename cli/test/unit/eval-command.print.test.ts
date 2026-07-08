// SPDX-License-Identifier: Apache-2.0
// FDRS-656/657 — `pome eval` prints the CLOUD verdict (label + score line +
// dashboard URL) to the terminal and writes NO score.json. The verdict is
// ephemeral: it lives in the cloud, the CLI only echoes it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_SESSION_ID = "ses_print_test";
const FAKE_RUN_ID = "run_print_test";
const DASHBOARD_URL = `https://dashboard.example.com/runs/${FAKE_RUN_ID}`;

// Hoisted stub so the vi.mock factories (which are hoisted above imports) can
// reference it.
const stub = vi.hoisted(() => {
  return {
    finalizeScore: 100 as number,
    client: {
      async createEvalSession(input: { agent: string; taskName: string }) {
        void input;
        return {
          session_id: FAKE_SESSION_ID,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        };
      },
      async requestEventsUploadUrl() {
        return { url: "https://signed.example/events", key: "k/events.jsonl" };
      },
      async requestStateUploadUrl() {
        return {
          state_initial: { url: "https://signed.example/si", key: "k/si.json" },
          state_final: { url: "https://signed.example/sf", key: "k/sf.json" },
        };
      },
      async requestSignalsUploadUrl() {
        return { url: "https://signed.example/sig", key: "k/sig.jsonl" };
      },
      async requestMetaUploadUrl() {
        return { url: "https://signed.example/meta", key: "k/meta.json" };
      },
      async finalize() {
        return {
          run_id: FAKE_RUN_ID,
          score: stub.finalizeScore,
          judge_model: "test-judge",
          dashboard_url: DASHBOARD_URL,
        };
      },
    },
  };
});

vi.mock("../../src/cli/credentials.js", () => ({
  resolveCredentials: vi.fn(async () => ({
    apiBaseUrl: "http://no-cloud.invalid",
    apiKey: "pme_test",
  })),
}));

vi.mock("../../src/hosted/client.js", () => ({
  createHostedClient: () => stub.client,
}));

import { runEvalCommand } from "../../src/cli/eval.js";

const META = {
  run_id: "ses_orig",
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
  run_id: "ses_orig",
  twin: "github",
  request_id: "req_1",
  method: "GET",
  path: "/repos/acme/api",
  status: 200,
});

async function writeRunDir(root: string): Promise<string> {
  const runDir = join(root, "runs", "01-bug-happy-path", "ses_orig");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "meta.json"), JSON.stringify(META, null, 2));
  await writeFile(join(runDir, "events.jsonl"), `${EVENT_LINE}\n`);
  await writeFile(join(runDir, "state_initial.json"), '{"repositories": []}\n');
  await writeFile(join(runDir, "state_final.json"), '{"repositories": []}\n');
  return runDir;
}

describe("pome eval terminal output (FDRS-657)", () => {
  let tmp: string;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-eval-print-"));
    stub.finalizeScore = 100;
    process.exitCode = undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if ((init as RequestInit | undefined)?.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      throw new Error("unexpected non-PUT fetch");
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
    await rm(tmp, { recursive: true, force: true });
  });

  it("prints PASS + cloud score line + dashboard URL, writes no score.json", async () => {
    const runDir = await writeRunDir(tmp);
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await runEvalCommand(runDir, {
      artifactsDir: "runs",
      apiUrl: "http://no-cloud.invalid",
      agent: "triage-bot",
    });

    const out = lines.join("\n");
    expect(out).toMatch(/PASS 01-bug-happy-path/);
    expect(out).toMatch(/score: 100\/100/);
    expect(out).toContain(`cloud: ${DASHBOARD_URL}`);
    // Ephemeral verdict — nothing persisted next to the trace.
    expect(existsSync(join(runDir, "score.json"))).toBe(false);
    // But the idempotency marker IS persisted.
    expect(existsSync(join(runDir, "eval-session.json"))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("sub-threshold cloud score → FAIL label + exit 1", async () => {
    const runDir = await writeRunDir(tmp);
    stub.finalizeScore = 40;
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await runEvalCommand(runDir, {
      artifactsDir: "runs",
      apiUrl: "http://no-cloud.invalid",
      agent: "triage-bot",
    });

    const out = lines.join("\n");
    expect(out).toMatch(/FAIL 01-bug-happy-path/);
    expect(out).toContain(`cloud: ${DASHBOARD_URL}`);
    expect(existsSync(join(runDir, "score.json"))).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
