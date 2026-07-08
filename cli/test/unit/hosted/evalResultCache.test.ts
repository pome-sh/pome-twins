// SPDX-License-Identifier: Apache-2.0
// FDRS-644 — the per-trial cloud verdict artifact (verdict.json): write/read
// roundtrip, the two-level scan, run-set grouping, latest-FAILED selection,
// and the fix-prompt discovery semantics (trial dir → its set regardless of
// outcome; root → latest failed set). Foreign/corrupt files never throw.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERDICT_ARTIFACT_VERSION,
  discoverRunSet,
  groupRunSets,
  latestFailedRunSet,
  loadTrialEvents,
  readVerdictArtifact,
  scanVerdictArtifacts,
  writeVerdictArtifact,
  type VerdictArtifact,
} from "../../../src/hosted/evalResultCache.js";

function verdict(over: Partial<VerdictArtifact>): VerdictArtifact {
  return {
    version: VERDICT_ARTIFACT_VERSION,
    source: "cloud-finalize",
    task_name: "scn",
    scenario_path: "scenarios/scn.md",
    group_id: null,
    session_id: "ses_x",
    cloud_run_id: "run_x",
    cloud_dashboard_url: "https://app.pome.sh/runs/run_x",
    judge_model: "test-judge",
    score: 100,
    pass_threshold: 100,
    passed: true,
    criteria_results: [
      {
        criterion: { type: "model", text: "Severity is set correctly" },
        passed: true,
        skipped: false,
        reason: "ok",
      },
    ],
    duration_ms: 1000,
    finalized_at: "2026-07-06T00:00:00.000Z",
    ...over,
  };
}

async function writeTrial(
  root: string,
  slug: string,
  sid: string,
  over: Partial<VerdictArtifact>,
): Promise<string> {
  const runDir = join(root, slug, sid);
  await mkdir(runDir, { recursive: true });
  await writeVerdictArtifact(runDir, verdict({ session_id: sid, ...over }));
  return runDir;
}

describe("verdict artifact (FDRS-644)", () => {
  it("write/read roundtrip; corrupt and foreign files read as null", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-"));
    const runDir = join(tmp, "scn", "ses_1");
    await mkdir(runDir, { recursive: true });
    await writeVerdictArtifact(runDir, verdict({ session_id: "ses_1" }));
    const read = await readVerdictArtifact(runDir);
    expect(read?.verdict.session_id).toBe("ses_1");
    expect(read?.verdict.source).toBe("cloud-finalize");

    const corrupt = join(tmp, "scn", "ses_2");
    await mkdir(corrupt, { recursive: true });
    await writeFile(join(corrupt, "verdict.json"), "{not json", "utf8");
    expect(await readVerdictArtifact(corrupt)).toBeNull();

    const foreign = join(tmp, "scn", "ses_3");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "verdict.json"), '{"hello":"world"}', "utf8");
    expect(await readVerdictArtifact(foreign)).toBeNull();

    expect(await readVerdictArtifact(join(tmp, "scn", "nope"))).toBeNull();
  });

  it("rejects half-recognizable files instead of crashing downstream (adversarial fix)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-hostile-"));
    const base = verdict({});

    // finalized_at missing → groupRunSets would crash sorting on it.
    const noFinalized = join(tmp, "scn", "h1");
    await mkdir(noFinalized, { recursive: true });
    const { finalized_at: _f, ...rest } = base;
    await writeFile(join(noFinalized, "verdict.json"), JSON.stringify(rest), "utf8");
    expect(await readVerdictArtifact(noFinalized)).toBeNull();

    // criteria_results elements must be shaped — [null] and [{}] crash
    // prompt assembly if let through.
    for (const [name, results] of [
      ["h2", [null]],
      ["h3", [{}]],
      ["h4", [{ criterion: { text: 42 }, reason: "x", passed: true, skipped: false }]],
    ] as const) {
      const dir = join(tmp, "scn", name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "verdict.json"),
        JSON.stringify({ ...base, criteria_results: results }),
        "utf8",
      );
      expect(await readVerdictArtifact(dir)).toBeNull();
    }
  });

  it("scan walks exactly <root>/<slug>/<runId>/verdict.json and skips junk", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-scan-"));
    await writeTrial(tmp, "scn", "ses_1", {});
    await writeTrial(tmp, "other", "ses_2", { task_name: "other" });
    await writeFile(join(tmp, "loose.json"), "{}", "utf8");
    await mkdir(join(tmp, "scn", "empty-dir"), { recursive: true });

    const scanned = await scanVerdictArtifacts(tmp);
    expect(scanned.map((t) => t.verdict.session_id).sort()).toEqual([
      "ses_1",
      "ses_2",
    ]);
    expect(await scanVerdictArtifacts(join(tmp, "missing"))).toEqual([]);
  });

  it("groups by group_id (solo runs are their own sets) and finds the latest FAILED set", async () => {
    const trials = [
      // group A: newer, all passed
      { runDir: "a1", verdict: verdict({ group_id: "grp_a", session_id: "a1", finalized_at: "2026-07-06T03:00:00Z" }) },
      { runDir: "a2", verdict: verdict({ group_id: "grp_a", session_id: "a2", finalized_at: "2026-07-06T03:01:00Z" }) },
      // group B: older, one failed
      { runDir: "b1", verdict: verdict({ group_id: "grp_b", session_id: "b1", finalized_at: "2026-07-06T01:00:00Z" }) },
      { runDir: "b2", verdict: verdict({ group_id: "grp_b", session_id: "b2", passed: false, score: 40, finalized_at: "2026-07-06T01:01:00Z" }) },
      // solo run, failed, oldest
      { runDir: "s1", verdict: verdict({ session_id: "s1", passed: false, finalized_at: "2026-07-06T00:00:00Z" }) },
    ];
    const sets = groupRunSets(trials);
    expect(sets).toHaveLength(3);
    // Sorted by latest finalize ascending; trials inside sorted ascending.
    expect(sets.map((s) => s.groupId)).toEqual([null, "grp_b", "grp_a"]);
    expect(sets[2]!.anyFailed).toBe(false);
    expect(sets[1]!.anyFailed).toBe(true);
    expect(sets[1]!.trials.map((t) => t.verdict.session_id)).toEqual(["b1", "b2"]);

    // Latest FAILED ≠ latest overall: grp_a is newest but green.
    expect(latestFailedRunSet(sets)?.groupId).toBe("grp_b");
  });

  it("discoverRunSet(root): latest failed set; all-green roots return set=null with totalSets>0", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-root-"));
    await writeTrial(tmp, "scn", "g1", { group_id: "grp_g", finalized_at: "2026-07-06T05:00:00Z" });
    await writeTrial(tmp, "scn", "f1", { group_id: "grp_f", passed: false, score: 0, finalized_at: "2026-07-06T04:00:00Z" });

    const d = await discoverRunSet(tmp);
    expect(d.kind).toBe("root");
    expect(d.totalSets).toBe(2);
    expect(d.set?.groupId).toBe("grp_f");

    const green = await mkdtemp(join(tmpdir(), "verdict-green-"));
    await writeTrial(green, "scn", "g2", { group_id: "grp_h" });
    const dg = await discoverRunSet(green);
    expect(dg.totalSets).toBe(1);
    expect(dg.set).toBeNull();

    const empty = await mkdtemp(join(tmpdir(), "verdict-empty-"));
    const de = await discoverRunSet(empty);
    expect(de.totalSets).toBe(0);
    expect(de.set).toBeNull();

    const missing = await discoverRunSet(join(empty, "nope"));
    expect(missing.totalSets).toBe(0);
  });

  it("discoverRunSet(trial dir): that trial's whole set, even when it passed", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-trial-"));
    const t1 = await writeTrial(tmp, "scn", "t1", { group_id: "grp_t", finalized_at: "2026-07-06T01:00:00Z" });
    await writeTrial(tmp, "scn", "t2", { group_id: "grp_t", passed: false, finalized_at: "2026-07-06T01:01:00Z" });
    await writeTrial(tmp, "scn", "z9", { group_id: "grp_z", passed: false, finalized_at: "2026-07-06T09:00:00Z" });

    const d = await discoverRunSet(t1);
    expect(d.kind).toBe("trial-dir");
    expect(d.set?.groupId).toBe("grp_t");
    expect(d.set?.trials.map((t) => t.verdict.session_id)).toEqual(["t1", "t2"]);
  });

  it("loadTrialEvents skips corrupt rows and tolerates a missing file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-events-"));
    await writeFile(
      join(tmp, "events.jsonl"),
      '{"kind":"twin_http","path":"/a"}\nnot json\n\n{"kind":"twin_http","path":"/b"}\n',
      "utf8",
    );
    const events = await loadTrialEvents(tmp);
    expect(events).toHaveLength(2);
    expect(await loadTrialEvents(join(tmp, "missing"))).toEqual([]);
  });

  it("loadTrialEvents drops valid-JSON non-object rows (null, numbers, strings)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-events2-"));
    await writeFile(
      join(tmp, "events.jsonl"),
      'null\n3\n"x"\n{"kind":"twin_http","path":"/a"}\n',
      "utf8",
    );
    const events = await loadTrialEvents(tmp);
    expect(events).toHaveLength(1);
  });
});
