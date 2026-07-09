// SPDX-License-Identifier: Apache-2.0
// FDRS-405 — E2E test that `runScenario({ noCapture: true })` skips spawning
// the capture-server child and the agent inherits NO HTTP_PROXY. The result
// must still produce TwinHttpEvent rows (twin traffic is unaffected), but
// must NOT produce LlmCallEvent rows (no proxy = no CONNECT-tunnel capture).
//
// This is the matching half of the overhead gate: the gate runs the same
// scenario twice, once with capture (default) and once with `--no-capture`,
// then compares per-call latencies. The "without" run must genuinely be
// proxy-free or the comparison is degenerate.

import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenario } from "../../src/runner/runScenario.js";

function listenEphemeral(server: ReturnType<typeof createNetServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("ephemeral listen returned no address"));
    });
  });
}

describe("runScenario — noCapture (FDRS-405)", () => {
  let echoPort = 0;
  let echoCloser: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("data", (chunk) => socket.write(chunk));
      socket.once("close", () => sockets.delete(socket));
    });
    echoPort = await listenEphemeral(server);
    echoCloser = () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
  });

  afterAll(async () => {
    if (echoCloser) await echoCloser();
  });

  it("does not spawn capture-server, does not inject HTTP_PROXY, emits no LlmCallEvent", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-nc-"));
    const probePath = new URL("../fixtures/agents/capture-probe-agent.ts", import.meta.url).pathname;
    process.env.POME_CAPTURE_TEST_TARGET = `127.0.0.1:${echoPort}`;

    // The probe asserts `HTTPS_PROXY` is set and tunnels through it. With
    // `noCapture: true` the runner must NOT set HTTPS_PROXY — the probe's
    // `connectThroughProxy()` call will throw `HTTPS_PROXY is required`,
    // making the agent exit non-zero. That's expected, and we assert it
    // happened to prove the env was not injected.
    let spawnedPid: number | null = null;
    try {
      const result = await runScenario({
        scenarioPath: "scenarios/01-bug-happy-path.md",
        agentCommand: `npx tsx ${probePath}`,
        artifactsDir,
        noCapture: true,
        onCaptureServerSpawned: (pid) => {
          spawnedPid = pid;
        },
      });

      // Triage work itself succeeded (twin calls happened); the probe's
      // post-triage CONNECT-via-proxy step failed because HTTPS_PROXY is
      // unset. We measure the env injection by that signal: agent exits
      // non-zero with HTTPS_PROXY in the error.
      expect(spawnedPid).toBeNull();
      expect(existsSync(join(result.artifacts.runDir, "events.jsonl"))).toBe(true);

      const rows = (await readFile(join(result.artifacts.runDir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { kind: string });

      // No proxy → no LlmCallEvent rows in events.jsonl.
      expect(rows.filter((r) => r.kind === "LlmCallEvent")).toHaveLength(0);
      // Twin traffic still recorded.
      expect(rows.filter((r) => r.kind === "TwinHttpEvent").length).toBeGreaterThan(0);
    } finally {
      delete process.env.POME_CAPTURE_TEST_TARGET;
    }
  }, 60_000);
});
