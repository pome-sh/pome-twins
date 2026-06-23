// SPDX-License-Identifier: Apache-2.0
// FDRS-399 test helper. Tests invoke `runScenario` under vitest, where
// `process.argv[1]` is vitest's worker entry — not pome's main — so the
// default child-process spawn (`process.execPath process.argv[1] ...`)
// doesn't boot the capture-server. Tests pass this override to point the
// runner at `bun src/cli/main.ts capture-server ...` instead.

import type { CaptureServerCommand } from "../../src/runner/runScenario.js";

export const captureServerForTests: CaptureServerCommand = {
  execPath: "bun",
  prefixArgs: ["src/cli/main.ts"],
};
