// SPDX-License-Identifier: Apache-2.0
// F-709 acceptance — `pome twin start` as a real child process: boots the
// twin as a foreground server, reuses the secret persisted at the F-708
// contract location (POME_TWIN_DATA_DIR override), and both the JWT it
// prints AND a JWT minted from the persisted secret authenticate against
// the running twin. Ctrl-C (SIGINT) stops it cleanly. The frozen control
// plane itself is asserted by contract/cli-start.test.mjs; this test owns
// the secret read path + the printed-token journey.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "hono/jwt";
import { afterEach, describe, expect, it } from "vitest";

const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_BIN = join(CLI_ROOT, "node_modules", ".bin", "tsx");
const MAIN_TS = join(CLI_ROOT, "src", "cli", "main.ts");
const PERSISTED_SECRET = "e2e-persisted-secret-0123456789abcdef";

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address() as { port: number };
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
});

describe("pome twin start (e2e)", () => {
  it(
    "serves /healthz, honors the persisted secret, and stops on SIGINT",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-e2e-"));
      const dataDir = join(cwd, "twin-data");
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "secret"), `${PERSISTED_SECRET}\n`);

      const port = await freePort();
      const env: NodeJS.ProcessEnv = { ...process.env, POME_TWIN_DATA_DIR: dataDir };
      delete env.TWIN_AUTH_SECRET; // the persisted-file branch under test
      child = spawn(TSX_BIN, [MAIN_TS, "twin", "start", "github", "--port", String(port)], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => { output += chunk; });
      child.stderr?.on("data", (chunk) => { output += chunk; });
      const exited = new Promise<number | null>((resolve) => child?.once("exit", (code) => resolve(code)));

      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const res = await fetch(`${base}/healthz`);
          if (res.status === 200) break;
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) {
          throw new Error(`twin start never answered /healthz 200\n--- output ---\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // The server can accept connections before the parent process receives
      // the child's buffered startup output. Wait for the observable message
      // instead of racing the stdout/stderr data events against /healthz.
      const secretMessage = `using the persisted secret from ${join(dataDir, "secret")}`;
      const outputDeadline = Date.now() + 5_000;
      while (!output.includes(secretMessage) && child.exitCode === null) {
        if (Date.now() > outputDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(output).toContain(secretMessage);

      // A JWT minted from the persisted secret authenticates (the CLI and
      // the running twin resolved the same secret).
      const minted = await sign(
        { sid: "standalone", team_id: "tm_local", exp: Math.floor(Date.now() / 1000) + 3600 },
        PERSISTED_SECRET,
      );
      const viaFileSecret = await fetch(`${base}/s/standalone/_pome/health`, {
        headers: { Authorization: `Bearer ${minted}` },
      });
      expect(viaFileSecret.status).toBe(200);

      // The ready-to-use token the command prints works as printed.
      const printed = output.match(/POME_AUTH_TOKEN=(\S+)/)?.[1];
      expect(printed).toBeTruthy();
      const viaPrintedToken = await fetch(`${base}/s/standalone/_pome/health`, {
        headers: { Authorization: `Bearer ${printed}` },
      });
      expect(viaPrintedToken.status).toBe(200);

      // Foreground contract: Ctrl-C stops the server and exits 0.
      child.kill("SIGINT");
      await expect(exited).resolves.toBe(0);
    },
    90_000,
  );
});
