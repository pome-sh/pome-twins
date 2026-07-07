// SPDX-License-Identifier: Apache-2.0
//
// F-681 proof-of-harness suite: runs the IDENTICAL frozen FDRS-711 slack
// assertions (contract/suite.mjs) against the slack twin booted through the
// @pome-sh/sdk engine (contract/proof/slack-sdk-server.mjs) instead of the
// twin's own dist/src/server.js. Green here means the engine reproduces the
// twin's frozen control-plane wire behavior end-to-end — the acceptance
// gate for the defineTwin() harness before the real ports (F-682/683/684).
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
  entry: "contract/proof/slack-sdk-server.mjs",
};

contractSuite(slackViaSdk, PER_TWIN.slack, "slack (sdk boot)");

describe("contract: sdk boot — admin gate token mode + boot guard", () => {
  adminGateCase(slackViaSdk, "slack (sdk boot)");
  bootGuardCase(slackViaSdk, "slack (sdk boot)");
});
