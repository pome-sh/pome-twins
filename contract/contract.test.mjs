// SPDX-License-Identifier: Apache-2.0
//
// Black-box twin runtime-contract suite (FDRS-711). Spawns each BUILT twin
// exactly the way pome-cloud does (`node dist/src/server.js`, cwd = package
// root, TWIN_AUTH_SECRET/PORT injected) and asserts the control-plane surface
// documented in /CONTRACT.md from outside the process.
//
// These assertions FREEZE observed wire behavior — including per-twin
// divergences that are themselves under review (see FDRS-712). Changing any
// asserted status or shape is a contract change: update CONTRACT.md in the
// same PR and coordinate the pome-cloud consumer PR per the contract doc.
// The suite body lives in ./suite.mjs (FDRS-681) so the identical assertions
// also run against the sdk-booted proof entry (./sdk-boot.test.mjs).
//
// Prerequisite: `bun run --filter '@pome-sh/shared-types' build:runtime` and
// `bun run --filter '@pome-sh/twin-*' build` (the root `test:contract` script
// chains all three).

import { describe } from "node:test";
import { TWINS } from "./helpers.mjs";
import { PER_TWIN, adminGateCase, bootGuardCase, contractSuite } from "./suite.mjs";

for (const twin of TWINS) {
  contractSuite(twin, PER_TWIN[twin.name]);
}

describe("contract: admin gate token mode + boot guards", () => {
  for (const twin of TWINS) {
    adminGateCase(twin);
    bootGuardCase(twin);
  }
});
