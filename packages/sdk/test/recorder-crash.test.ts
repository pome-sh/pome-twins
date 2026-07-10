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
    const armedPath = join(dir, "armed");
    const childScript = join(dir, "crash-child.ts");

    const TOTAL = 20;
    // Flush TOTAL-1 events, then enqueue one more without flush so SIGKILL
    // can only lose that in-flight write.
    const FLUSHED = TOTAL - 1;
    await writeFile(
      childScript,
      `
import { writeFileSync } from "node:fs";
import { createFileBackedRecorderStore } from ${JSON.stringify(
        join(PKG_ROOT, "src/recorder.ts")
      )};

const path = process.env.EVENTS_PATH!;
const readyPath = process.env.READY_PATH!;
const armedPath = process.env.ARMED_PATH!;
const total = Number(process.env.TOTAL);
const flushed = Number(process.env.FLUSHED);
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
  for (let i = 0; i < flushed; i++) {
    store.record(event(i));
    await store.flush!();
  }
  writeFileSync(readyPath, String(flushed));
  // One more accepted write without awaiting flush — the only event that
  // SIGKILL is allowed to lose.
  store.record(event(flushed));
  writeFileSync(armedPath, String(total));
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
        ARMED_PATH: armedPath,
        TOTAL: String(TOTAL),
        FLUSHED: String(FLUSHED),
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
          const armed = await readFile(armedPath, "utf8");
          if (Number(armed) >= TOTAL) break;
        } catch {
          // not armed yet
        }
        if (child.exitCode !== null) {
          throw new Error(
            `crash child exited early (${child.exitCode}): stderr=${stderr} stdout=${stdout}`
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      let armedCount = 0;
      try {
        armedCount = Number(await readFile(armedPath, "utf8"));
      } catch {
        armedCount = 0;
      }
      if (armedCount < TOTAL) {
        killChild();
        throw new Error(
          `crash child never reached armed barrier (armed=${armedCount}): stderr=${stderr} stdout=${stdout}`
        );
      }

      const exited = new Promise<void>((resolvePromise) =>
        child.once("exit", () => resolvePromise())
      );
      killChild();
      if (child.exitCode === null) {
        await Promise.race([
          exited,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("child did not exit after SIGKILL")), 5_000)
          ),
        ]);
      }

      const raw = await readFile(eventsPath, "utf8");
      // Tolerate only a trailing partial line from SIGKILL mid-write. A
      // corrupt complete row earlier in the file must fail the gate.
      const rawLines = raw.split("\n").map((l) => l.trim());
      while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
        rawLines.pop();
      }
      const completeLines: string[] = [];
      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i]!;
        const isLast = i === rawLines.length - 1;
        try {
          JSON.parse(line);
          completeLines.push(line);
        } catch {
          if (!isLast) {
            throw new Error(`corrupt NDJSON row before trailing line: ${line.slice(0, 120)}`);
          }
          // Trailing partial — drop it from the durable count.
        }
      }

      expect(completeLines.length).toBeLessThanOrEqual(TOTAL);
      // Child flushed FLUSHED events, then armed after enqueueing the last.
      // Loss is bounded to that single in-flight write.
      expect(completeLines.length).toBeGreaterThanOrEqual(FLUSHED);
      expect(completeLines.length).toBeGreaterThanOrEqual(TOTAL - 1);

      for (const line of completeLines) {
        const row = JSON.parse(line) as unknown;
        const result = twinHttpEventSchema.safeParse(row);
        expect(result.success, JSON.stringify(result)).toBe(true);
        expect((row as { kind: string }).kind).toBe("TwinHttpEvent");
      }
    } finally {
      killChild();
    }
  }, 30_000);
});
