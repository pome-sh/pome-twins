// SPDX-License-Identifier: Apache-2.0
// FDRS-399 — spawn `pome capture-server` as a child process for `pome run`.
//
// The runner needs an out-of-process CONNECT proxy so the agent subprocess
// can be pointed at it via HTTPS_PROXY. Running capture-server in-process is
// possible but the ticket scope requires child-process isolation (capture
// crashes don't take the runner down; standalone deployment parity).
//
// Contract with `cli/src/capture-server/run.ts`:
//   - On boot the server writes
//       pome capture-server listening on 127.0.0.1:<port> (events → <path>)
//     to stderr. We parse the port from that line.
//   - SIGTERM triggers a drain + exit 0. We send SIGTERM and await `exit`,
//     falling back to SIGKILL after `shutdownGraceMs` so a buggy build can't
//     leak processes.

import { spawn, type ChildProcess } from "node:child_process";

export interface SpawnCaptureServerChildOptions {
  // Absolute path to events.jsonl. Passed verbatim to `--events-out`.
  eventsOut: string;
  // Override for tests. Defaults to process.execPath.
  execPath?: string;
  // Override for tests. When omitted we re-invoke this binary
  // (process.argv[1]) with `capture-server --port 0 --events-out <path>`.
  binArgs?: string[];
  // Max time to wait for the listening line before rejecting. Default 5s.
  readyTimeoutMs?: number;
  // Max time to wait for SIGTERM to land before SIGKILL. Default 5s.
  shutdownGraceMs?: number;
}

export interface CaptureServerChildHandle {
  port: number;
  pid: number;
  // Idempotent. SIGTERM, await exit, SIGKILL fallback after shutdownGraceMs.
  shutdown(): Promise<void>;
}

const LISTENING_REGEX = /listening on 127\.0\.0\.1:(\d+)/;

export async function spawnCaptureServerChild(
  options: SpawnCaptureServerChildOptions,
): Promise<CaptureServerChildHandle> {
  const execPath = options.execPath ?? process.execPath;
  const binArgs =
    options.binArgs ??
    defaultBinArgs(options.eventsOut);
  const readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
  const shutdownGraceMs = options.shutdownGraceMs ?? 5_000;

  const child = spawn(execPath, binArgs, {
    stdio: ["ignore", "ignore", "pipe"],
    env: process.env,
  });

  let stderrBuf = "";
  let resolved = false;

  const readyPromise = new Promise<number>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      stderrBuf += chunk.toString("utf8");
      // Cap at 8KB to avoid unbounded buffering if the child spews logs.
      if (stderrBuf.length > 8_192) stderrBuf = stderrBuf.slice(-8_192);
      const match = LISTENING_REGEX.exec(stderrBuf);
      if (match) {
        resolved = true;
        cleanup();
        resolve(Number(match[1]));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (resolved) return;
      cleanup();
      const detail = stderrBuf.trim().slice(0, 2_048);
      reject(
        new Error(
          `pome capture-server exited (code=${code} signal=${signal}) before printing the listening line.${detail ? `\nstderr: ${detail}` : ""}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      if (resolved) return;
      cleanup();
      reject(
        new Error(
          `pome capture-server did not start listening within ${readyTimeoutMs}ms.${stderrBuf ? `\nstderr: ${stderrBuf.trim().slice(0, 2_048)}` : ""}`,
        ),
      );
    }, readyTimeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });

  let port: number;
  try {
    port = await readyPromise;
  } catch (err) {
    // Best-effort cleanup so a boot failure doesn't leak a process.
    if (!child.killed) child.kill("SIGKILL");
    throw err;
  }

  // After the listening line we keep draining stderr to /dev/null so the
  // child's pipe buffer doesn't fill and block its writes mid-run.
  child.stderr?.on("data", () => {});

  const pid = child.pid;
  if (pid === undefined) {
    // Practically unreachable — spawn always returns a pid once the child has
    // emitted output. Guard anyway so the type narrows.
    child.kill("SIGKILL");
    throw new Error("pome capture-server child has no pid after boot");
  }

  return {
    port,
    pid,
    shutdown: makeShutdown(child, shutdownGraceMs),
  };
}

function defaultBinArgs(eventsOut: string): string[] {
  // process.argv[1] is the script path we were invoked with. Re-invoking it
  // gives us the same binary (and the same code) without depending on PATH
  // having a `pome` shim — important when running from the dev tree
  // (`tsx src/cli/main.ts`).
  const script = process.argv[1];
  if (typeof script !== "string" || script.length === 0) {
    throw new Error(
      "Cannot determine pome binary path (process.argv[1] is empty). Pass `binArgs` explicitly.",
    );
  }
  return [script, "capture-server", "--port", "0", "--events-out", eventsOut];
}

function makeShutdown(
  child: ChildProcess,
  graceMs: number,
): () => Promise<void> {
  let done: Promise<void> | null = null;
  return () => {
    if (done) return done;
    done = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const onExit = (): void => {
        clearTimeout(killTimer);
        resolve();
      };
      child.once("exit", onExit);
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
        child.off("exit", onExit);
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, graceMs);
    });
    return done;
  };
}
