#!/usr/bin/env node
/**
 * Regression coverage for scripts/ci/wait-for-workflow.sh (F-696).
 * Mocks curl on PATH and asserts success / failure / newest-run selection /
 * in-progress polling / timeout / cancelled. Also asserts twin-image.yml waits
 * on both ci.yml and secret-scan.yml.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/wait-for-workflow.sh");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function runWaitFixed(responses, { workflow = "ci.yml", sha = "abc", timeoutS = "5" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wait-wf-"));
  const curl = join(dir, "curl");
  writeFileSync(join(dir, "payloads.json"), JSON.stringify(responses));
  writeFileSync(join(dir, "n"), "0");
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
nfile="$(dirname "$0")/n"
payloads_file="$(dirname "$0")/payloads.json"
n=$(cat "$nfile")
echo $((n + 1)) >"$nfile"
# When payloads are exhausted, repeat the last payload (keeps timeout loops alive).
node -e '
const fs = require("fs");
const payloads = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const n = Number(process.argv[2]);
const idx = Math.min(n, payloads.length - 1);
process.stdout.write(JSON.stringify(payloads[idx]));
' "$payloads_file" "$n"
`,
  );
  chmodSync(curl, 0o755);

  const result = spawnSync("bash", [SCRIPT, workflow, sha], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "pome-sh/pome-twins",
      GITHUB_TOKEN: "test-token",
      WAIT_INTERVAL_S: "0",
      WAIT_TIMEOUT_S: timeoutS,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

function main() {
  {
    const r = runWaitFixed([
      {
        workflow_runs: [{ id: 1, status: "completed", conclusion: "success" }],
      },
    ]);
    assert(r.status === 0, `expected success, got ${r.status}: ${r.stderr}`);
    assert(r.stdout.includes("succeeded"), r.stdout);
  }

  {
    const r = runWaitFixed([
      {
        workflow_runs: [{ id: 9, status: "completed", conclusion: "failure" }],
      },
    ]);
    assert(r.status === 1, `expected failure exit, got ${r.status}`);
    const out = `${r.stdout}\n${r.stderr}`;
    assert(out.includes("concluded failure"), out);
  }

  {
    const r = runWaitFixed([
      {
        workflow_runs: [
          { id: 2, status: "completed", conclusion: "failure" },
          { id: 1, status: "completed", conclusion: "success" },
        ],
      },
    ]);
    assert(r.status === 1, "must not accept older success while newest failed");
  }

  {
    const r = runWaitFixed([
      {
        workflow_runs: [{ id: 3, status: "in_progress", conclusion: null }],
      },
      {
        workflow_runs: [{ id: 3, status: "completed", conclusion: "success" }],
      },
    ]);
    assert(r.status === 0, `expected poll-then-success, got ${r.status}: ${r.stderr}`);
    assert(r.stdout.includes("succeeded"), r.stdout);
  }

  {
    const r = runWaitFixed([
      {
        workflow_runs: [{ id: 4, status: "completed", conclusion: "cancelled" }],
      },
    ]);
    assert(r.status === 1, `expected cancelled to fail, got ${r.status}`);
    const out = `${r.stdout}\n${r.stderr}`;
    assert(out.includes("concluded cancelled"), out);
  }

  {
    const r = runWaitFixed([{ workflow_runs: [] }], { timeoutS: "1" });
    assert(r.status === 1, `expected timeout, got ${r.status}`);
    const out = `${r.stdout}\n${r.stderr}`;
    assert(out.includes("timed out"), out);
  }

  {
    const y = readFileSync(join(ROOT, ".github/workflows/twin-image.yml"), "utf8");
    assert(/wait-for-workflow\.sh ci\.yml/.test(y), "twin-image must wait for ci.yml");
    assert(
      /wait-for-workflow\.sh secret-scan\.yml/.test(y),
      "twin-image must wait for secret-scan.yml",
    );
    assert(
      /needs:\s*wait-gates/.test(y) || /needs:\s*\[\s*wait-gates\s*\]/.test(y),
      "publish must need wait-gates",
    );
  }

  console.log("✅ wait-for-workflow regression tests passed");
}

main();
