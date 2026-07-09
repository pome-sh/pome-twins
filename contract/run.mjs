// SPDX-License-Identifier: Apache-2.0
//
// Orchestrator for the twin runtime-contract suite (FDRS-711): build the
// shared-types runtime JS + the three twins, run the black-box suite with
// plain `node`, then remove the runtime JS that build:runtime emits next to
// packages/shared-types/src/*.ts. Those files are untracked (the Docker
// builds emit them in-image only); left behind they shadow the .ts sources
// and break `lint:dead-code`.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_SRC = path.join(REPO_ROOT, "packages", "shared-types", "src");

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit" });
  return res.status ?? 1;
}

// Only remove `X.js` when `X.ts` sits next to it — the exact inverse of
// tsconfig.runtime.json's in-place emit. Nothing else is touched.
function cleanRuntimeJs(dir) {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += cleanRuntimeJs(full);
    } else if (entry.name.endsWith(".js") && existsSync(`${full.slice(0, -3)}.ts`)) {
      rmSync(full);
      removed += 1;
    }
  }
  return removed;
}

let status = run("npm", ["run", "build:runtime", "-w", "@pome-sh/shared-types"]);
// The sdk build must precede the twin builds: twin-slack is a thin
// @pome-sh/sdk plugin since F-683 and compiles against the sdk dist.
if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/sdk"]);
if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-github"]);
if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-slack"]);
if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-stripe"]);
if (status === 0) status = run("node", ["--test", "contract/contract.test.mjs", "contract/sdk-boot.test.mjs"]);

const removed = cleanRuntimeJs(SHARED_SRC);
console.log(`[contract/run] cleaned ${removed} generated runtime .js file(s) from packages/shared-types/src`);
process.exit(status);
