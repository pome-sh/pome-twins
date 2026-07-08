// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — runScenarioHosted's trial seams against a fake cloud:
//
//   - `premintedSession` skips the runner's own POST /v1/sessions (trial
//     groups mint all k upfront) while the `finally` teardown still DELETEs
//     the trial's own session;
//   - `abandonOnFailure` turns agent failures (preflight fail / timeout /
//     non-zero exit) and machinery crashes into POST /:id/abandon with a
//     machine error_code + a thrown HostedTrialError — an errored trial
//     must NEVER produce a judged run row (no /finalize);
//   - the abandon lands BEFORE the teardown DELETE, so error_code is
//     recorded while the session row is still open;
//   - default mode (no flag) keeps today's behavior: agent timeout still
//     finalizes (covered by runScenarioHosted.test.ts, re-asserted here).

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { sign as signJwt } from "hono/jwt";
import { runScenarioHosted } from "../../src/runner/runScenarioHosted.js";
import { HostedTrialError } from "../../src/hosted/errors.js";
import type { CreateSessionResponse } from "../../src/types/shared.js";

const TWIN_AUTH_SECRET = "test-secret-32-chars-minimum-length";
const SESSION_ID = "ses_preminted";

const SCENARIO =
  "# Trivial\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [D] No unsupported endpoint was called\n";
const FAST_TIMEOUT_SCENARIO =
  "# Slow\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [D] No unsupported endpoint was called\n\n## Config\n```yaml\ntimeout: 1\n```\n";
// timeout (11) deliberately EXCEEDS the 10s preflight cap so the hung-preflight
// test below can distinguish the quoted durations: the abandon reason must say
// 10s (the cap that actually killed it), never 11s (the scenario timeout).
const PREFLIGHT_HANG_SCENARIO =
  "# Hang\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [D] No unsupported endpoint was called\n\n## Config\n```yaml\ntimeout: 11\n```\n";

interface FakeCloud {
  port: number;
  close: () => void;
  mintCalls: () => number;
  finalizeCalls: () => number;
  abandonBodies: () => Array<Record<string, unknown>>;
  deletes: () => string[];
  /** interleaved log of session-lifecycle calls, e.g. ["abandon","delete"] */
  lifecycle: () => string[];
}

async function startFakeCloud(opts?: { stateStatus?: number }): Promise<FakeCloud> {
  let mintCalls = 0;
  let finalizeCalls = 0;
  const abandonBodies: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];
  const lifecycle: string[] = [];
  let port = 0;

  const app = new Hono();
  app.post("/v1/sessions", async (c) => {
    mintCalls += 1;
    const token = await signJwt(
      { sid: SESSION_ID, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) + 600 },
      TWIN_AUTH_SECRET,
    );
    return c.json({
      session_id: SESSION_ID,
      session_token: "pst_test_trial",
      twin_url: `http://127.0.0.1:${port}/s/${SESSION_ID}`,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      agent_token: token,
      openapi_url: `http://127.0.0.1:${port}/openapi.json`,
      per_twin: {},
    });
  });
  app.get("/s/:sid/_pome/state", (c) => {
    if (opts?.stateStatus && opts.stateStatus !== 200) {
      return c.json({ message: "twin pod restarted" }, opts.stateStatus as 500);
    }
    return c.json({
      repositories: [
        { owner: "acme", name: "api", full_name: "acme/api", labels: [], issues: [] },
      ],
    });
  });
  app.get("/s/:sid/_pome/events", (c) => c.json([]));
  app.post("/v1/sessions/:id/finalize", (c) => {
    finalizeCalls += 1;
    return c.json(
      {
        run_id: "run_x",
        score: 100,
        judge_model: "test-judge",
        dashboard_url: "http://127.0.0.1/runs/run_x",
      },
      201,
    );
  });
  app.post("/v1/sessions/:id/abandon", async (c) => {
    const raw = await c.req.text();
    const body = raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
    abandonBodies.push(body);
    lifecycle.push("abandon");
    return c.json({
      session_id: c.req.param("id"),
      state: "failed",
      error_code: (body.error_code as string | undefined) ?? null,
      abandoned: true,
    });
  });
  app.delete("/v1/sessions/:id", (c) => {
    deletes.push(c.req.param("id"));
    lifecycle.push("delete");
    return c.json({ id: c.req.param("id"), state: "expired" });
  });

  let server: ServerType;
  port = await new Promise<number>((res) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      res(info.port),
    );
  });

  return {
    port,
    close: () => server!.close(),
    mintCalls: () => mintCalls,
    finalizeCalls: () => finalizeCalls,
    abandonBodies: () => abandonBodies,
    deletes: () => deletes,
    lifecycle: () => lifecycle,
  };
}

async function premintedFor(port: number): Promise<CreateSessionResponse> {
  const token = await signJwt(
    { sid: SESSION_ID, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) + 600 },
    TWIN_AUTH_SECRET,
  );
  return {
    session_id: SESSION_ID,
    session_token: "pst_test_trial",
    twin_url: `http://127.0.0.1:${port}/s/${SESSION_ID}`,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    agent_token: token,
    provider_credentials: {},
    openapi_url: `http://127.0.0.1:${port}/openapi.json`,
    per_twin: {},
  };
}

describe("runScenarioHosted trial seams (FDRS-636)", () => {
  let cloud: FakeCloud | undefined;
  let tmp: string | undefined;

  afterEach(async () => {
    cloud?.close();
    cloud = undefined;
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  async function scenarioPath(source: string): Promise<string> {
    tmp = await mkdtemp(join(tmpdir(), "pome-trial-seam-"));
    const p = join(tmp, "scn.md");
    await writeFile(p, source, "utf8");
    return p;
  }

  it("premintedSession skips the runner's own mint and still DELETEs on teardown", async () => {
    cloud = await startFakeCloud();
    const path = await scenarioPath(SCENARIO);

    const result = await runScenarioHosted({
      scenarioPath: path,
      agentCommand: `node -e ${JSON.stringify("console.log('done')")}`,
      artifactsDir: join(tmp!, "runs"),
      hosted: { baseUrl: `http://127.0.0.1:${cloud.port}`, apiKey: "pme_test" },
      premintedSession: await premintedFor(cloud.port),
    });

    expect(result.exitCode).toBe(0);
    expect(result.runId).toBe(SESSION_ID);
    expect(cloud.mintCalls()).toBe(0); // the group minted upfront
    expect(cloud.finalizeCalls()).toBe(1);
    expect(cloud.deletes()).toEqual([SESSION_ID]);
    // FDRS-636 — the runner reports the trial duration for the verdict table.
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("abandonOnFailure + non-zero agent exit → abandon(agent_exit_nonzero), no finalize, HostedTrialError", async () => {
    cloud = await startFakeCloud();
    const path = await scenarioPath(SCENARIO);

    // Preflight (POME_PREFLIGHT=1) succeeds; the real run exits 1.
    const agent = `node -e ${JSON.stringify("process.exit(process.env.POME_PREFLIGHT ? 0 : 1)")}`;

    let thrown: unknown;
    try {
      await runScenarioHosted({
        scenarioPath: path,
        agentCommand: agent,
        artifactsDir: join(tmp!, "runs"),
        hosted: { baseUrl: `http://127.0.0.1:${cloud.port}`, apiKey: "pme_test" },
        premintedSession: await premintedFor(cloud.port),
        abandonOnFailure: true,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HostedTrialError);
    expect((thrown as HostedTrialError).errorCode).toBe("agent_exit_nonzero");
    expect(cloud.finalizeCalls()).toBe(0);
    expect(cloud.abandonBodies()).toEqual([{ error_code: "agent_exit_nonzero" }]);
    // Abandon lands while the session row is still open — before the DELETE.
    expect(cloud.lifecycle()).toEqual(["abandon", "delete"]);
  });

  it("abandonOnFailure + preflight failure → abandon(preflight_failed), no finalize; reason names the stderr tail and forensics land in artifactsDir (FDRS-667)", async () => {
    cloud = await startFakeCloud();
    const path = await scenarioPath(SCENARIO);
    // Mimics the first-publish e2e: the example's preflight throws its named
    // cause to stderr and exits 1. That cause must surface in the errored
    // trial row instead of a bare "agent preflight failed".
    const agent = `node -e ${JSON.stringify(
      "console.error('twin not reachable at http://127.0.0.1:3333/healthz: fetch failed'); process.exit(1)",
    )}`;

    await expect(
      runScenarioHosted({
        scenarioPath: path,
        agentCommand: agent,
        artifactsDir: join(tmp!, "runs"),
        hosted: { baseUrl: `http://127.0.0.1:${cloud.port}`, apiKey: "pme_test" },
        premintedSession: await premintedFor(cloud.port),
        abandonOnFailure: true,
      }),
    ).rejects.toMatchObject({
      errorCode: "preflight_failed",
      message:
        "agent preflight failed — twin not reachable at http://127.0.0.1:3333/healthz: fetch failed",
    });

    expect(cloud.finalizeCalls()).toBe(0);
    expect(cloud.abandonBodies()).toEqual([{ error_code: "preflight_failed" }]);

    // FDRS-667 — an abandoned trial still writes stdout.txt/stderr.log where
    // a completed trial's artifacts would go, so `runs/` is never empty.
    const files = await readdir(join(tmp!, "runs"), { recursive: true });
    const stderrLog = files.find((f) => String(f).endsWith("stderr.log"));
    expect(stderrLog, `runs/ contained: ${files.join(", ")}`).toBeDefined();
    expect(
      await readFile(join(tmp!, "runs", String(stderrLog)), "utf8"),
    ).toContain("twin not reachable at http://127.0.0.1:3333/healthz");
  });

  it("injects POME_TWIN_BASE_URL = session twin_url so loopback-fallback agents pass hosted preflight (FDRS-667)", async () => {
    cloud = await startFakeCloud();
    const path = await scenarioPath(SCENARIO);
    const expected = `http://127.0.0.1:${cloud.port}/s/${SESSION_ID}`;
    // Exits 0 (both preflight and run) only when the env mirrors self-host.
    const agent = `node -e ${JSON.stringify(
      `process.exit(process.env.POME_TWIN_BASE_URL === '${expected}' ? 0 : 1)`,
    )}`;

    const result = await runScenarioHosted({
      scenarioPath: path,
      agentCommand: agent,
      artifactsDir: join(tmp!, "runs"),
      hosted: { baseUrl: `http://127.0.0.1:${cloud.port}`, apiKey: "pme_test" },
      premintedSession: await premintedFor(cloud.port),
      abandonOnFailure: true,
    });

    expect(result.exitCode).toBe(0);
    expect(cloud.finalizeCalls()).toBe(1);
    expect(cloud.abandonBodies()).toEqual([]);
  });

  it("abandonOnFailure + preflight HANG past its cap → abandon(preflight_failed) quoting the 10s cap, not the scenario timeout", async () => {
    cloud = await startFakeCloud();
    const path = await scenarioPath(PREFLIGHT_HANG_SCENARIO);
    // Preflight hangs forever (killed at the min(10, timeout)=10s cap); the
    // real run would exit 0, but it must never be reached.
    const agent = `node -e ${JSON.stringify(
      "if (process.env.POME_PREFLIGHT) { setTimeout(() => {}, 60000); } else { process.exit(0); }",
    )}`;

    await expect(
      runScenarioHosted({
        scenarioPath: path,
        agentCommand: agent,
        artifactsDir: join(tmp!, "runs"),
        hosted: { baseUrl: `http://127.0.0.1:${cloud.port}`, apiKey: "pme_test" },
        premintedSession: await premintedFor(cloud.port),
        abandonOnFailure: true,
      }),
    ).rejects.toMatchObject({
      errorCode: "preflight_failed",
      // The reason quotes the limit that actually killed the preflight (10s),
      // NOT scenario.config.timeout (11s) — the errored trial card renders
      // this cause verbatim.
      message: "agent preflight timed out after 10s",
    });

    expect(cloud.finalizeCalls()).toBe(0);
    expect(cloud.abandonBodies()).toEqual([{ error_code: "preflight_failed" }]);
    expect(cloud.lifecycle()).toEqual(["abandon", "delete"]);
  }, 30_000);

  it("abandonOnFailure + agent timeout → abandon(agent_timeout), no finalize", async () => {
    cloud = await startFakeCloud();
    const path = await scenarioPath(FAST_TIMEOUT_SCENARIO);
    // Preflight exits 0 instantly; the real run outlives the 1s timeout.
    const agent = `node -e ${JSON.stringify(
      "if (process.env.POME_PREFLIGHT) process.exit(0); setTimeout(() => {}, 5000)",
    )}`;

    await expect(
      runScenarioHosted({
        scenarioPath: path,
        agentCommand: agent,
        artifactsDir: join(tmp!, "runs"),
        hosted: { baseUrl: `http://127.0.0.1:${cloud.port}`, apiKey: "pme_test" },
        premintedSession: await premintedFor(cloud.port),
        abandonOnFailure: true,
      }),
    ).rejects.toMatchObject({ errorCode: "agent_timeout" });

    expect(cloud.finalizeCalls()).toBe(0);
    expect(cloud.abandonBodies()).toEqual([{ error_code: "agent_timeout" }]);
  }, 30_000);

  it("abandonOnFailure + machinery crash (twin state 500) → abandon(trial_crashed), original error rethrown", async () => {
    cloud = await startFakeCloud({ stateStatus: 500 });
    const path = await scenarioPath(SCENARIO);

    await expect(
      runScenarioHosted({
        scenarioPath: path,
        agentCommand: `node -e ${JSON.stringify("console.log('done')")}`,
        artifactsDir: join(tmp!, "runs"),
        hosted: { baseUrl: `http://127.0.0.1:${cloud.port}`, apiKey: "pme_test" },
        premintedSession: await premintedFor(cloud.port),
        abandonOnFailure: true,
      }),
    ).rejects.toThrow(/twin pod restarted/);

    expect(cloud.finalizeCalls()).toBe(0);
    expect(cloud.abandonBodies()).toEqual([{ error_code: "trial_crashed" }]);
    expect(cloud.lifecycle()).toEqual(["abandon", "delete"]);
  });

  it("default mode (k=1 path) is untouched: agent failure still finalizes, no abandon", async () => {
    cloud = await startFakeCloud();
    const path = await scenarioPath(SCENARIO);
    const agent = `node -e ${JSON.stringify("process.exit(process.env.POME_PREFLIGHT ? 0 : 1)")}`;

    const result = await runScenarioHosted({
      scenarioPath: path,
      agentCommand: agent,
      artifactsDir: join(tmp!, "runs"),
      hosted: { baseUrl: `http://127.0.0.1:${cloud.port}`, apiKey: "pme_test" },
      premintedSession: await premintedFor(cloud.port),
    });

    // Cloud judged 100 → pass; abandon never fired.
    expect(result.exitCode).toBe(0);
    expect(cloud.finalizeCalls()).toBe(1);
    expect(cloud.abandonBodies()).toEqual([]);
  });
});
