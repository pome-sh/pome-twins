// SPDX-License-Identifier: Apache-2.0
//
// Engine SQLite driver wrapper (F-681), backed by node:sqlite since F-703 —
// zero native deps, no compiler toolchain at install. Twins never import a
// sqlite driver directly — they call `openTwinDatabase()` and consume the
// `TwinDatabase` interface below. The interface keeps better-sqlite3's shape
// (prepare/exec/pragma/transaction/close) because twin domain code has dozens
// of call sites relying on it; node:sqlite ships no pragma()/transaction()
// equivalents, so this file emulates them: `pragma()` prepares a `PRAGMA …`
// statement, `transaction(fn)` (+ `.immediate`) wraps fn in explicit
// BEGIN [IMMEDIATE]/COMMIT/ROLLBACK at the outermost level and in a SAVEPOINT
// when called inside an open transaction — better-sqlite3's nesting semantics,
// which twin-github's seed() relies on (it wraps createIssue et al., each of
// which opens its own transaction).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Mutation outcome — the shape both better-sqlite3's `RunResult` and
 * node:sqlite's `StatementResultingChanges` return; `changes` is coerced to
 * number, `lastInsertRowid` may be a bigint for rowids beyond safe-integer
 * range.
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
 * runs its mutations under it.
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

class NodeSqliteTwinDatabase implements TwinDatabase {
  readonly #db: DatabaseSync;
  #savepointId = 0;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
  }

  prepare(sql: string): TwinStatement {
    const statement = this.#db.prepare(sql);
    type Params = Parameters<typeof statement.run>;
    return {
      run: (...params: unknown[]): TwinRunResult => {
        const result = statement.run(...(params as Params));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      get: (...params: unknown[]): unknown => statement.get(...(params as Params)),
      all: (...params: unknown[]): unknown[] => statement.all(...(params as Params)),
    };
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  pragma(statement: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.#db.prepare(`PRAGMA ${statement}`).all() as Array<Record<string, unknown>>;
    if (!options.simple) return rows;
    const row = rows[0];
    if (row === undefined) return undefined;
    return row[Object.keys(row)[0] as string];
  }

  transaction<F extends (...args: never[]) => unknown>(fn: F): TwinTransaction<F> {
    const wrap = (begin: string): F =>
      ((...args: never[]) => {
        if (this.#db.isTransaction) return this.#nested(fn, args);
        this.#db.exec(begin);
        try {
          const out = fn(...args);
          this.#db.exec("COMMIT");
          return out;
        } catch (error) {
          // Certain failures (e.g. ON CONFLICT ROLLBACK) end the transaction
          // themselves — only roll back when one is still open.
          if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
          throw error;
        }
      }) as F;
    const tx = wrap("BEGIN") as TwinTransaction<F>;
    tx.immediate = wrap("BEGIN IMMEDIATE");
    return tx;
  }

  /**
   * A transaction function called inside an open transaction joins it under a
   * SAVEPOINT (better-sqlite3's semantics): success releases the savepoint,
   * failure rolls back only the inner work. The BEGIN variant is irrelevant
   * here — the outermost transaction already holds the lock mode.
   */
  #nested<F extends (...args: never[]) => unknown>(fn: F, args: never[]): unknown {
    const name = `_pome_tx_${this.#savepointId++}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn(...args);
      this.#db.exec(`RELEASE ${name}`);
      return out;
    } catch (error) {
      if (this.#db.isTransaction) {
        this.#db.exec(`ROLLBACK TO ${name}`);
        this.#db.exec(`RELEASE ${name}`);
      }
      throw error;
    }
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
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
  const db = new NodeSqliteTwinDatabase(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  options.migrate?.(db);
  return db;
}
