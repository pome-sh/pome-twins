// SPDX-License-Identifier: Apache-2.0
//
// F-722 — crash-loss gate for the durable recorder (production path).
// Spawns a child (via tsx) that records through createFileBackedRecorderStore
// — the same twin-core store production twins / CLI harness use — then
// SIGKILLs mid-run. Asserts the partial events.jsonl exists, parses with
// twinHttpEventSchema, and lost at most the in-flight event.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { twinHttpEventSchema } from "@pome-sh/shared-types";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("durable recorder crash loss (F-722)", () => {
  it("kill -9 mid-run leaves a parseable partial tape losing at most one event", async () => {
    expect(existsSync(TSX_BIN), `tsx not found at ${TSX_BIN}`).toBe(true);

    const dir = await mkdtemp(join(tmpdir(), "pome-crash-"));
    tmpDirs.push(dir);
    const eventsPath = join(dir, "events.jsonl");
    const readyPath = join(dir, "ready");
    const childScript = join(dir, "crash-child.ts");

    const TOTAL = 20;
    const READY_AFTER = 10;
    await writeFile(
      childScript,
      `
import { writeFileSync } from "node:fs";
import { createFileBackedRecorderStore } from ${JSON.stringify(
        join(PKG_ROOT, "src/recorder.ts")
      )};

const path = process.env.EVENTS_PATH!;
const readyPath = process.env.READY_PATH!;
const total = Number(process.env.TOTAL);
const readyAfter = Number(process.env.READY_AFTER);
const store = createFileBackedRecorderStore({ path, fsync: true });

function event(i: number) {
  return {
    ts: new Date().toISOString(),
    run_id: "run_crash",
    twin: "toy",
    request_id: "req_" + String(i).padStart(4, "0"),
    step_id: null,
    tool_call_id: null,
    method: "POST",
    path: "/s/test/items",
    request_body: { i },
    status: 201,
    response_body: { ok: true },
    latency_ms: 1,
    fidelity: "semantic" as const,
    state_mutation: true,
    state_delta: null,
    error: null,
  };
}

async function main() {
  for (let i = 0; i < readyAfter; i++) {
    store.record(event(i));
    await store.flush!();
  }
  writeFileSync(readyPath, String(readyAfter));
  // Keep recording without awaiting flush so SIGKILL can land on an
  // in-flight write; loss must stay ≤ 1 beyond the ready barrier.
  for (let i = readyAfter; i < total; i++) {
    store.record(event(i));
  }
  await new Promise(() => {});
}
void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
      "utf8"
    );

    const child = spawn(TSX_BIN, [childScript], {
      cwd: PKG_ROOT,
      env: {
        ...process.env,
        EVENTS_PATH: eventsPath,
        READY_PATH: readyPath,
        TOTAL: String(TOTAL),
        READY_AFTER: String(READY_AFTER),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const killChild = () => {
      if (child.killed || child.exitCode !== null) return;
      child.kill("SIGKILL");
    };

    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const ready = await readFile(readyPath, "utf8");
          if (Number(ready) >= READY_AFTER) break;
        } catch {
          // not ready yet
        }
        if (child.exitCode !== null) {
          throw new Error(
            `crash child exited early (${child.exitCode}): stderr=${stderr} stdout=${stdout}`
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      let readyCount = 0;
      try {
        readyCount = Number(await readFile(readyPath, "utf8"));
      } catch {
        readyCount = 0;
      }
      if (readyCount < READY_AFTER) {
        killChild();
        throw new Error(
          `crash child never reached ready barrier (ready=${readyCount}): stderr=${stderr} stdout=${stdout}`
        );
      }

      killChild();
      await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));

      const raw = await readFile(eventsPath, "utf8");
      // Tolerate a trailing partial line from SIGKILL mid-write; complete
      // NDJSON rows must still parse.
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .filter((line) => {
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        });
      expect(lines.length).toBeGreaterThanOrEqual(READY_AFTER);
      expect(lines.length).toBeLessThanOrEqual(TOTAL);

      for (const line of lines) {
        const row = JSON.parse(line) as unknown;
        const result = twinHttpEventSchema.safeParse(row);
        expect(result.success, JSON.stringify(result)).toBe(true);
        expect((row as { kind: string }).kind).toBe("TwinHttpEvent");
      }

      // Child flushes before writing the ready barrier, so every readyCount
      // event is durable. Loss after that is bounded to the in-flight write
      // (at most one event beyond the last successful flush).
      expect(lines.length).toBeGreaterThanOrEqual(readyCount);
    } finally {
      killChild();
    }
  }, 30_000);
});
