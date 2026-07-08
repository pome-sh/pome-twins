// SPDX-License-Identifier: Apache-2.0
//
// Engine SQLite driver wrapper (F-681). Twins never import a sqlite driver
// directly — they call `openTwinDatabase()` and consume the `TwinDatabase`
// interface below. The interface is a same-shape subset of better-sqlite3
// (prepare/exec/pragma/transaction/close), which is exactly the surface the
// M2 node:sqlite swap (F-703) re-implements: swapping the driver is a change
// to THIS file only. `transaction(fn)` keeps better-sqlite3's shape (returns
// a callable running fn atomically) because twin domain code has dozens of
// call sites relying on it and node:sqlite ships no equivalent — the M2
// implementation backs it with BEGIN IMMEDIATE/COMMIT/ROLLBACK.
//
// The driver is loaded lazily via createRequire so @pome-sh/sdk can declare
// better-sqlite3 as an optional peer dependency: twins that bring their own
// database never pay for (or compile) the native module.

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/**
 * Mutation outcome — the shape both better-sqlite3's `RunResult` and
 * node:sqlite's `StatementResultingChanges` return, so the M2 swap (F-703)
 * keeps this interface as-is.
 */
export interface TwinRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface TwinStatement {
  run(...params: unknown[]): TwinRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * A wrapped transaction function (better-sqlite3's shape). The `.immediate`
 * variant takes the write lock up front (BEGIN IMMEDIATE) — github's domain
 * runs its mutations under it. The M2 node:sqlite implementation backs both
 * call forms with explicit BEGIN [IMMEDIATE]/COMMIT/ROLLBACK.
 */
export type TwinTransaction<F extends (...args: never[]) => unknown> = F & { immediate: F };

export interface TwinDatabase {
  prepare(sql: string): TwinStatement;
  exec(sql: string): void;
  pragma(statement: string, options?: { simple?: boolean }): unknown;
  /** Same shape as better-sqlite3: wraps `fn` so calling it runs atomically. */
  transaction<F extends (...args: never[]) => unknown>(fn: F): TwinTransaction<F>;
  close(): void;
}

export interface OpenTwinDatabaseOptions {
  /** Schema migration hook, run once right after the pragmas are applied. */
  migrate?: (db: TwinDatabase) => void;
}

type BetterSqlite3Ctor = new (path: string) => TwinDatabase;

let driver: BetterSqlite3Ctor | undefined;

function loadDriver(): BetterSqlite3Ctor {
  if (!driver) {
    const require = createRequire(import.meta.url);
    driver = require("better-sqlite3") as BetterSqlite3Ctor;
  }
  return driver;
}

/**
 * Open a twin database with the pome pragma set applied:
 * `busy_timeout = 5000`, `journal_mode = WAL` (file-backed), and
 * `foreign_keys = ON` — the exact pragmas every twin's hand-rolled db.ts
 * applied before F-681 centralized them.
 */
export function openTwinDatabase(
  path = ":memory:",
  options: OpenTwinDatabaseOptions = {}
): TwinDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const Database = loadDriver();
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  options.migrate?.(db);
  return db;
}
