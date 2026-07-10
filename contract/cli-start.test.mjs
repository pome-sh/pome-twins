// SPDX-License-Identifier: Apache-2.0
//
// CLI front-door contract suite (F-709). Runs the same frozen FDRS-711
// assertions against twins started via `pome twin start <twin>` — the
// docker-free quickstart path — instead of the packaged boot entries. The
// CLI boots the twins in-process (cli/src/twin/twinHarness.ts) from its
// @pome-sh/* dependencies, so this suite is the proof that the front door
// serves the identical control plane + admin surface CONTRACT.md freezes.
//
// Prerequisite: a built CLI (`cd cli && npm ci && npm run build`) — chained
// by cli-ci.yml, NOT by the root `test:contract` script (the CLI is not a
// root workspace). Run locally with `node --test contract/cli-start.test.mjs`.
//
// bootGuardCase is deliberately absent: `pome twin start` binds loopback
// only, so the F-708 non-loopback self-generation guard lives with the
// packaged entries (contract.test.mjs). The CLI's read side of the secret
// contract (env wins → persisted `.pome-data/<twin>/secret` → ephemeral)
// is covered by the CLI's own unit + e2e suites.

import { describe } from "node:test";
import { PER_TWIN, adminGateCase, contractSuite } from "./suite.mjs";

// `PORT` env drives the bind (twin start falls back to $PORT before 3333),
// TWIN_AUTH_SECRET env-injection wins over any persisted secret, and the
// db env vars keep the github twin on :memory: (slack/stripe already are).
// The 3s healthz bound is the packaged-entry contract; the CLI front door
// loads the full CLI import graph first, so it gets a looser 15s bound.
const cliStart = (name, dbEnv) => ({
  name,
  pkg: "cli",
  dbEnv,
  entry: "cli/dist/src/cli/main.js",
  args: ["twin", "start", name],
  healthzDeadlineMs: 15_000,
});

const TWINS = [
  cliStart("github", "GITHUB_CLONE_DB"),
  cliStart("slack", "SLACK_CLONE_DB"),
  cliStart("stripe", "STRIPE_CLONE_DB"),
];

for (const twin of TWINS) {
  contractSuite(twin, PER_TWIN[twin.name], `${twin.name} (pome twin start)`);
}

describe("contract: pome twin start — admin gate token mode", () => {
  for (const twin of TWINS) {
    adminGateCase(twin, `${twin.name} (pome twin start)`);
  }
});
