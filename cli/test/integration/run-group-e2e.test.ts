// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — `pome run -n k` end-to-end against a STUB cloud, in the pattern
// of demo-e2e.test.ts: the REAL runTrialGroup + runScenarioHosted machinery
// (per-trial preflight, agent subprocess, state/events capture, presigned
// uploads, finalize/abandon, teardown DELETE) with a scripted control plane.
// Everything short of the real cloud + a real judge — the founder's Phase G
// live run covers those.

import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runTrialGroup } from "../../src/runner/runTrialGroup.js";
import {
  discoverRunSet,
  readVerdictArtifact,
} from "../../src/hosted/evalResultCache.js";

const SCENARIO =
  "# Trivial\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [D] No unsupported endpoint was called\n";

interface StubCloud {
  server: Server;
  port: number;
  minted: Array<Record<string, unknown>>;
  finalized: Array<{ sessionId: string; body: Record<string, unknown> }>;
  abandoned: Array<{ sessionId: string; body: Record<string, unknown> }>;
  deleted: string[];
  putKeys: string[];
}

// Trials keyed by mint order: ses_1 passes (100), ses_2's agent crashes
// (never finalizes — abandoned), ses_3 completes but fails the judge (58).
function finalizeResponse(sessionId: string, port: number): unknown {
  const failing = sessionId === "ses_3";
  return {
    run_id: `run_${sessionId}`,
    score: failing ? 58 : 100,
    judge_model: "test-judge",
    dashboard_url: `http://127.0.0.1:${port}/runs/run_${sessionId}`,
    criteria_results: [
      {
        criterion: { type: "P", text: "Severity is set correctly" },
        outcome: failing ? "failed" : "passed",
        passed: !failing,
        skipped: false,
        reason: failing ? "under-rated" : "ok",
      },
    ],
  };
}

async function startStubCloud(): Promise<StubCloud> {
  const minted: StubCloud["minted"] = [];
  const finalized: StubCloud["finalized"] = [];
  const abandoned: StubCloud["abandoned"] = [];
  const deleted: string[] = [];
  const putKeys: string[] = [];
  let port = 0;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const url = req.url ?? "";
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (req.method === "PUT" && url.startsWith("/put/")) {
        putKeys.push(url);
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === "POST" && url === "/v1/sessions") {
        minted.push(JSON.parse(raw) as Record<string, unknown>);
        const n = minted.length;
        json(201, {
          session_id: `ses_${n}`,
          session_token: `pst_test_${n}`,
          twin_url: `http://127.0.0.1:${port}/s/ses_${n}`,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          agent_token: `tok_${n}`,
          openapi_url: `http://127.0.0.1:${port}/openapi.json`,
          per_twin: {},
        });
        return;
      }

      const stateMatch = url.match(/^\/s\/([^/]+)\/_pome\/state$/);
      if (req.method === "GET" && stateMatch) {
        json(200, {
          repositories: [
            { owner: "acme", name: "api", full_name: "acme/api", labels: [], issues: [] },
          ],
        });
        return;
      }
      const eventsMatch = url.match(/^\/s\/([^/]+)\/_pome\/events$/);
      if (req.method === "GET" && eventsMatch) {
        json(200, []);
        return;
      }

      const uploadMatch = url.match(
        /^\/v1\/sessions\/([^/]+)\/(result-upload-url|state-upload-url|signals-upload-url)$/,
      );
      if (req.method === "POST" && uploadMatch) {
        const sid = uploadMatch[1]!;
        const route = uploadMatch[2]!;
        const base = `http://127.0.0.1:${port}`;
        if (route === "result-upload-url") {
          json(200, { url: `${base}/put/${sid}/events.jsonl`, key: `team-t/session-${sid}/events.jsonl` });
        } else if (route === "signals-upload-url") {
          json(200, { url: `${base}/put/${sid}/signals.jsonl`, key: `team-t/session-${sid}/signals.jsonl` });
        } else {
          json(200, {
            state_initial: {
              url: `${base}/put/${sid}/state_initial.json`,
              key: `team-t/session-${sid}/state_initial.json`,
            },
            state_final: {
              url: `${base}/put/${sid}/state_final.json`,
              key: `team-t/session-${sid}/state_final.json`,
            },
          });
        }
        return;
      }

      const finalizeMatch = url.match(/^\/v1\/sessions\/([^/]+)\/finalize$/);
      if (req.method === "POST" && finalizeMatch) {
        const sessionId = finalizeMatch[1]!;
        finalized.push({ sessionId, body: JSON.parse(raw) as Record<string, unknown> });
        json(201, finalizeResponse(sessionId, port));
        return;
      }

      const abandonMatch = url.match(/^\/v1\/sessions\/([^/]+)\/abandon$/);
      if (req.method === "POST" && abandonMatch) {
        const sessionId = abandonMatch[1]!;
        const body = raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
        abandoned.push({ sessionId, body });
        json(200, {
          session_id: sessionId,
          state: "failed",
          error_code: body.error_code ?? null,
          abandoned: true,
        });
        return;
      }

      const deleteMatch = url.match(/^\/v1\/sessions\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        deleted.push(deleteMatch[1]!);
        json(200, { id: deleteMatch[1], state: "expired" });
        return;
      }

      json(404, { error: { type: "not_found", message: `no stub for ${req.method} ${url}` } });
    });
  });

  port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("no address"));
    });
  });

  return { server, port, minted, finalized, abandoned, deleted, putKeys };
}

let cloud: StubCloud | null = null;
afterAll(async () => {
  if (cloud) {
    await new Promise<void>((resolve) => cloud!.server.close(() => resolve()));
  }
});

describe("pome run -n k end-to-end against a stub cloud (FDRS-636)", () => {
  it("mints k upfront (shared group_id, fresh idempotency keys) → sequential trials → verdict table + summary + reliability link", async () => {
    cloud = await startStubCloud();
    const tmp = await mkdtemp(join(tmpdir(), "pome-group-e2e-"));
    const scenarioPath = join(tmp, "scn.md");
    await writeFile(scenarioPath, SCENARIO, "utf8");
    const out: string[] = [];

    // The trial agent keys its behavior off POME_RUN_ID (= the trial's
    // session id): ses_2 crashes after preflight; everything else exits 0.
    const agent = `node -e ${JSON.stringify(
      "if (!process.env.POME_PREFLIGHT && process.env.POME_RUN_ID === 'ses_2') process.exit(1)",
    )}`;

    const result = await runTrialGroup({
      scenarioPath,
      agentCommand: agent,
      agentCommandSource: "pome.config.json",
      trials: 3,
      artifactsDir: join(tmp, "runs"),
      hosted: { baseUrl: `http://127.0.0.1:${cloud.port}`, apiKey: "pme_test" },
      dashboardBaseUrl: "https://app.pome.sh",
      out: (line) => out.push(line),
    });

    const text = out.join("\n");

    // Terminal shape (moment 04): hint → provisioning → spawning → numeric
    // verdict rows → divider → fraction over completed trials → start-there
    // → reliability handoff.
    expect(text).toContain(
      "-n sets how many isolated trials to run · the agent command comes from pome.config.json",
    );
    expect(text).toContain("provisioning 3 isolated github twins … ready");
    expect(text).toContain(`spawning agent ${agent} · from pome.config.json …`);
    expect(text).toMatch(/trial 1 {2}✓ {2}100 {6}\d+\.\ds/);
    expect(text).toMatch(/trial 2 {2}⚠ {2}errored {9}.+ — excluded/);
    expect(text).toMatch(/trial 3 {2}✗ {2}58 {7}\d+\.\ds {2}severity is set correctly/);
    expect(text).toContain("─────");
    expect(text).toContain("1 of 2 passed · 1 errored, excluded from the fraction");
    expect(text).toContain("severity is set correctly failed in 1 of 2 — start there");
    expect(text).toContain("full trace, per-criterion diffs, and the trial spread:");
    expect(text).toContain("→ https://app.pome.sh/runs/task/scn");

    // Exit contract: a completed trial failed → 1.
    expect(result.exitCode).toBe(1);

    // Mint: 3 sessions upfront, one shared grp_ id on every body, fresh
    // idempotency keys, base64 scenario source + resolved seed forwarded.
    expect(cloud.minted).toHaveLength(3);
    expect(result.groupId).toMatch(/^grp_[A-Za-z0-9_-]{21}$/);
    for (const mint of cloud.minted) {
      expect(mint.group_id).toBe(result.groupId);
      expect(mint.twins).toEqual(["github"]);
      expect(typeof mint.scenario_source).toBe("string");
    }
    const idemKeys = cloud.minted.map((m) => m.idempotency_key);
    expect(idemKeys.every((k) => typeof k === "string" && (k as string).length > 0)).toBe(true);
    expect(new Set(idemKeys).size).toBe(3);

    // Verdicts come from cloud evaluation only: completed trials finalized,
    // the crashed trial abandoned with a machine error_code and NO finalize.
    expect(cloud.finalized.map((f) => f.sessionId).sort()).toEqual(["ses_1", "ses_3"]);
    expect(cloud.abandoned).toEqual([
      { sessionId: "ses_2", body: { error_code: "agent_exit_nonzero" } },
    ]);

    // Each trial's teardown DELETEs its own session.
    expect(cloud.deleted.sort()).toEqual(["ses_1", "ses_2", "ses_3"]);

    // The completed trials' blobs were uploaded before finalize.
    expect(cloud.putKeys.filter((k) => k.includes("ses_1"))).toContain("/put/ses_1/events.jsonl");
    expect(cloud.putKeys.filter((k) => k.includes("ses_3"))).toContain("/put/ses_3/events.jsonl");

    // FDRS-644 — completed trials cached the CLOUD verdict next to the raw
    // trace; the abandoned trial has none (no verdict was ever produced).
    const v1 = await readVerdictArtifact(join(tmp, "runs", "scn", "ses_1"));
    const v3 = await readVerdictArtifact(join(tmp, "runs", "scn", "ses_3"));
    expect(v1?.verdict).toMatchObject({
      source: "cloud-finalize",
      task_name: "scn",
      group_id: result.groupId,
      session_id: "ses_1",
      passed: true,
      score: 100,
    });
    expect(v3?.verdict.passed).toBe(false);
    expect(v3?.verdict.criteria_results[0]?.reason).toBe("under-rated");
    expect(await readVerdictArtifact(join(tmp, "runs", "scn", "ses_2"))).toBeNull();

    // FDRS-644 — the fix & green handoff renders (a completed trial failed):
    // artifacts-dir-aware fix-prompt command + the literal re-run command.
    expect(text).toContain("fix & green: hand the failure signatures to your coding agent —");
    expect(text).toContain(`pome fix-prompt ${join(tmp, "runs")}`);
    expect(text).toContain(`after the fix lands, re-run the task:  pome run ${scenarioPath} -n 3`);

    // And fix-prompt's discovery reassembles this exact run set from disk.
    // Membership, not order: FDRS-663 runs trials in parallel, so within-set
    // order is finalized_at (completion) order and either trial can win.
    const discovery = await discoverRunSet(join(tmp, "runs"));
    expect(discovery.set?.groupId).toBe(result.groupId);
    expect(
      discovery.set?.trials.map((t) => t.verdict.session_id).sort(),
    ).toEqual(["ses_1", "ses_3"]);
  }, 120_000);
});
