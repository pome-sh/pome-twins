// SPDX-License-Identifier: Apache-2.0
//
// sdk-boot suite (F-681 → F-683). Before the port this ran the frozen
// FDRS-711 slack assertions against a proof entry (contract/proof/
// slack-sdk-server.mjs) that assembled the twin on the @pome-sh/sdk engine.
// Since F-683 the slack package's OWN entry (`node dist/src/server.js`, cwd
// = package root — the frozen boot contract) boots through defineTwin(), so
// the proof entry is superseded and deleted: this suite now spawns the real
// package and keeps the same 11 frozen assertions running against the
// sdk-booted twin, labeled distinctly from contract.test.mjs's run.
//
// Prerequisite: sdk + shared-types runtime + twin-slack builds (chained by
// contract/run.mjs via the root `test:contract` script).

import { describe } from "node:test";
import { PER_TWIN, adminGateCase, bootGuardCase, contractSuite } from "./suite.mjs";

const slackViaSdk = {
  name: "slack",
  pkg: "packages/twin-slack",
  dbEnv: "SLACK_CLONE_DB",
  hostEnv: "SLACK_CLONE_HOST",
};

contractSuite(slackViaSdk, PER_TWIN.slack, "slack (sdk boot)");

describe("contract: sdk boot — admin gate token mode + boot guard", () => {
  adminGateCase(slackViaSdk, "slack (sdk boot)");
  bootGuardCase(slackViaSdk, "slack (sdk boot)");
});
