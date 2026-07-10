// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — the packaged first-run demo task.
//
// `first-run-demo.md` (+ its hand-written seed sidecar) in this directory is
// the CANONICAL demo task content. The cloud's server-owned judge definition
// (pome-cloud apps/control-plane/src/lib/demo.ts,
// DEMO_TASK_DEFINITIONS["first-run-demo"]) is regenerated from that markdown;
// at finalize the cloud IGNORES the client body entirely and judges the
// server copy, so the CLI-side pin here is informational (mint sends
// task_hash: "").

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Server-allowlisted demo task name (mint + gateway + finalize key). */
export const DEMO_TASK_NAME = "first-run-demo";

/** The repo the packaged seed creates; handed to the bundled agent. */
export const DEMO_REPO = "acme/api";

/**
 * Absolute path of the packaged demo task markdown. Resolves next to this
 * module: `src/demo/` in the dev tree, `dist/src/demo/` in the published
 * package (copied by scripts/copy-prompts.mjs).
 */
export function demoTaskPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "first-run-demo.md");
  if (!existsSync(candidate)) {
    throw new Error(
      `Packaged demo task not found at ${candidate}. ` +
        "This is a packaging bug — the demo task markdown ships with @pome-sh/cli " +
        "(scripts/copy-prompts.mjs copies src/demo/ into dist/).",
    );
  }
  return candidate;
}
