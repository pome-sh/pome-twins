// SPDX-License-Identifier: Apache-2.0
//
// Multi-twin (M3) local runner mechanism: `runScenario` boots one bootTwin
// harness per config twin, all sharing ONE recorder so their events land in a
// single stream, and the runner (not the harness) owns the recorder's
// lifecycle. This covers the shared-recorder wiring in isolation without the
// full self-host e2e (agent + capture-server).
import { describe, expect, it } from "vitest";
import { defaultSeedState, seedSchema } from "@pome-sh/twin-github";
import { bootTwin } from "../../../src/twin/twinHarness.js";
import { createRecorder } from "../../../src/recorder/recorder.js";

describe("bootTwin shared recorder (multi-twin local runner)", () => {
  it("boots github + slack on one shared recorder and lets the caller own its lifecycle", async () => {
    const recorder = createRecorder(); // in-memory, runner-owned

    const github = await bootTwin({
      twin: "github",
      runId: "cli-multi-twin-test",
      seedState: seedSchema.parse(defaultSeedState()),
      recorder,
    });
    const slack = await bootTwin({
      twin: "slack",
      runId: "cli-multi-twin-test",
      seedState: {},
      recorder,
    });

    try {
      // Distinct env prefixes → distinct POME_<TWIN>_{REST,MCP}_URL fan-out.
      expect(github.envName).toBe("GITHUB");
      expect(slack.envName).toBe("SLACK");

      // Both harnesses read from the SAME shared buffer.
      expect(github.events()).toEqual(slack.events());

      // Each twin exports its own world.
      const githubState = (await github.exportState()) as { repositories?: unknown[] };
      expect(Array.isArray(githubState.repositories)).toBe(true);
      const slackState = await slack.exportState();
      expect(slackState).toBeTruthy();
    } finally {
      // Closing a harness that does NOT own the recorder must only release its
      // DB handle — the shared recorder stays usable for its siblings and is
      // closed once, by the caller, at the end.
      await github.close();
      // slack still works after a sibling closed.
      expect(await slack.exportState()).toBeTruthy();
      await slack.close();
      await recorder.close?.();
    }
  });
});
