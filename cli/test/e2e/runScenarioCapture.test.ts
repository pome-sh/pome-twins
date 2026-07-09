// SPDX-License-Identifier: Apache-2.0
// FDRS-399 — E2E test that `pome run` (via `runScenario`) spawns the
// capture-server child, routes the agent's outbound traffic through it
// via HTTPS_PROXY, and ends up with both LlmCallEvent (proxy-captured)
// and TwinHttpEvent (twin traffic, NO_PROXY bypass) rows in events.jsonl —
// with no orphan capture-server process after the run.

import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenario } from "../../src/runner/runScenario.js";
import { captureServerForTests } from "../fixtures/captureServerForTests.js";

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

function appendAllowlist(existing: string | undefined, name: string): string {
  const values = new Set((existing ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  values.add(name);
  return [...values].join(",");
}

describe("runScenario — capture-server wiring (FDRS-399)", () => {
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

  it("emits LlmCallEvent + TwinHttpEvent and leaves no orphan capture-server", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));
    const probePath = new URL("../fixtures/agents/capture-probe-agent.ts", import.meta.url).pathname;

    // Pin the target the probe will tunnel to. The fixture reads this from env;
    // opt into forwarding only this test-only variable through the hardened
    // agent environment allowlist.
    const previousAllowlist = process.env.POME_AGENT_ENV_ALLOWLIST;
    process.env.POME_CAPTURE_TEST_TARGET = `127.0.0.1:${echoPort}`;
    process.env.POME_AGENT_ENV_ALLOWLIST = appendAllowlist(previousAllowlist, "POME_CAPTURE_TEST_TARGET");

    let capturedPid = -1;
    try {
      const result = await runScenario({
        scenarioPath: "scenarios/01-bug-happy-path.md",
        agentCommand: `npx tsx ${probePath}`,
        artifactsDir,
        captureServerCommand: captureServerForTests,
        onCaptureServerSpawned: (pid) => {
          capturedPid = pid;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(result.artifacts.runDir, "events.jsonl"))).toBe(true);

      const rows = (await readFile(join(result.artifacts.runDir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { kind: string; host?: string; port?: number });

      const llm = rows.filter((r) => r.kind === "LlmCallEvent");
      const twin = rows.filter((r) => r.kind === "TwinHttpEvent");

      expect(llm.length).toBeGreaterThanOrEqual(1);
      expect(twin.length).toBeGreaterThanOrEqual(1);

      // The probe tunnels to the echo on 127.0.0.1:echoPort, so we expect ≥1
      // LlmCallEvent pointing at that exact host:port.
      const echoRow = llm.find((r) => r.host === "127.0.0.1" && r.port === echoPort);
      expect(echoRow, `expected an LlmCallEvent for 127.0.0.1:${echoPort}`).toBeDefined();

      // NO_PROXY=127.0.0.1,localhost must keep the twin's traffic out of the
      // proxy. The twin runs on 127.0.0.1:<random>; assert no LlmCallEvent
      // points at a localhost host other than the echo target. (Equivalent
      // formulation: no localhost LlmCallEvent has a port other than echoPort.)
      const localhostLlm = llm.filter(
        (r) => (r.host === "127.0.0.1" || r.host === "localhost") && r.port !== echoPort,
      );
      expect(
        localhostLlm,
        `twin traffic was captured through the proxy — NO_PROXY did not take effect: ${JSON.stringify(localhostLlm)}`,
      ).toHaveLength(0);
    } finally {
      delete process.env.POME_CAPTURE_TEST_TARGET;
      if (previousAllowlist === undefined) delete process.env.POME_AGENT_ENV_ALLOWLIST;
      else process.env.POME_AGENT_ENV_ALLOWLIST = previousAllowlist;
    }

    expect(capturedPid).toBeGreaterThan(0);
    // After the run returns, the captured pid must be gone (no orphan).
    expect(() => process.kill(capturedPid, 0)).toThrow(/ESRCH/);
  }, 60_000);
});
