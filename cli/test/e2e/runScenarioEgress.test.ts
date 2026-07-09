// SPDX-License-Identifier: Apache-2.0
// FDRS-635 — E2E test that `pome run` (via `runScenario`) enforces the
// deny-by-default egress floor end-to-end: the agent's CONNECT to a
// non-allowlisted host is refused with 403 (asserted inside the fixture),
// loopback tunnels still work, twin traffic is unaffected, and the refused
// host is surfaced on the run result so the CLI can name it in the output.

import { mkdtemp } from "node:fs/promises";
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

function appendAllowlist(existing: string | undefined, names: string[]): string {
  const values = new Set((existing ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  for (const name of names) values.add(name);
  return [...values].join(",");
}

describe("runScenario — egress floor wiring (FDRS-635)", () => {
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

  it("refuses the stray host, keeps loopback traffic, and names the refusal on the result", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));
    const probePath = new URL("../fixtures/agents/egress-probe-agent.ts", import.meta.url).pathname;

    const previousAllowlist = process.env.POME_AGENT_ENV_ALLOWLIST;
    process.env.POME_EGRESS_TEST_BLOCKED = "api.github.com:443";
    process.env.POME_CAPTURE_TEST_TARGET = `127.0.0.1:${echoPort}`;
    process.env.POME_AGENT_ENV_ALLOWLIST = appendAllowlist(previousAllowlist, [
      "POME_EGRESS_TEST_BLOCKED",
      "POME_CAPTURE_TEST_TARGET",
    ]);

    try {
      const result = await runScenario({
        scenarioPath: "scenarios/01-bug-happy-path.md",
        agentCommand: `npx tsx ${probePath}`,
        artifactsDir,
        captureServerCommand: captureServerForTests,
      });

      // The fixture exits non-zero if the blocked CONNECT was NOT refused
      // with 403 — so a passing run already proves the refusal happened.
      expect(result.exitCode).toBe(0);

      expect(result.blockedEgress).toEqual([
        { host: "api.github.com", port: 443, count: 1 },
      ]);
    } finally {
      delete process.env.POME_EGRESS_TEST_BLOCKED;
      delete process.env.POME_CAPTURE_TEST_TARGET;
      if (previousAllowlist === undefined) delete process.env.POME_AGENT_ENV_ALLOWLIST;
      else process.env.POME_AGENT_ENV_ALLOWLIST = previousAllowlist;
    }
  }, 60_000);
});
