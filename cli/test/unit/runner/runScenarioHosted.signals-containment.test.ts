// SPDX-License-Identifier: Apache-2.0
// FDRS-656 review fix 6 — the uploadAndFinalize extraction briefly moved the
// signals redactJsonl call OUT of a guarded path, so a throwing redaction
// aborted the whole hosted run where it previously degraded to "signals
// skipped". This locks the warn-and-continue contract: a redaction failure
// must not fail the run, and finalize must simply omit signalsStorageKey.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostedClient } from "../../../src/hosted/client.js";
import type {
  CreateSessionResponse,
  FinalizeResponse,
  SessionPublic,
} from "../../../src/types/shared.js";
import { HostedOrchError } from "../../../src/hosted/errors.js";

// Make redactJsonl throw while keeping the rest of the module real.
vi.mock("../../../src/hosted/uploadAndFinalize.js", async (importOriginal) => {
  const mod = await importOriginal<
    typeof import("../../../src/hosted/uploadAndFinalize.js")
  >();
  return {
    ...mod,
    redactJsonl: () => {
      throw new Error("redaction boom");
    },
  };
});

const { runScenarioHosted } = await import(
  "../../../src/runner/runScenarioHosted.js"
);

const TRIVIAL_PASSING_SCENARIO =
  "# Trivial\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [code] No unsupported endpoint was called\n";

describe("runScenarioHosted signals redaction containment", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-signals-containment-"));
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  it("a throwing signals redaction degrades to 'signals skipped' — the run completes", async () => {
    let finalizeInput: { signalsStorageKey?: string } | undefined;
    const client: HostedClient = {
      async createSession() {
        return {
          session_id: "ses_containment",
          twin_url: "http://no-twin.invalid/s/ses_containment",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          agent_token: "tok_test",
          openapi_url: "http://no-twin.invalid/openapi.json",
          provider_credentials: {},
        } as CreateSessionResponse;
      },
      async createEvalSession() {
        throw new HostedOrchError("no eval-session stubbed");
      },
      async listSessions() {
        return [] as SessionPublic[];
      },
      async getSession() {
        return {} as SessionPublic;
      },
      async fetchState() {
        return { repositories: [] };
      },
      async fetchEvents() {
        return [];
      },
      async finalize(_sessionId, input) {
        finalizeInput = input as typeof finalizeInput;
        return {
          run_id: "run_containment",
          score: 100,
          judge_model: "test-judge",
          dashboard_url: "https://dashboard.example.com/runs/run_containment",
        } satisfies FinalizeResponse;
      },
      async submitResult() {
        throw new HostedOrchError("not used");
      },
      async requestEventsUploadUrl() {
        throw new HostedOrchError("no route");
      },
      async requestStateUploadUrl() {
        throw new HostedOrchError("no route");
      },
      async requestSignalsUploadUrl() {
        throw new HostedOrchError("no route");
      },
      async requestMetaUploadUrl() {
        throw new HostedOrchError("no route");
      },
      async abandonSession() {
        throw new HostedOrchError("no abandon stubbed (single-run path never calls it)");
      },
      async deleteSession() {
        // no-op
      },
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

    expect(result.cloudRunId).toBe("run_containment");
    expect(finalizeInput?.signalsStorageKey).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("signals.jsonl upload skipped (redaction boom)"),
    );
  });
});
