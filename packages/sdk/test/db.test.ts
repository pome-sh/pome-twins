// SPDX-License-Identifier: Apache-2.0
//
// Engine db driver wrapper tests (F-681). Twins open SQLite through this
// wrapper only — `open` + pragmas + a same-shape `transaction()` helper — so
// the M2 node:sqlite swap (F-703) is a one-file change in the engine.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openTwinDatabase, type TwinDatabase } from "../src/db.js";

const tmp = mkdtempSync(join(tmpdir(), "sdk-db-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function withDb<T>(fn: (db: TwinDatabase) => T, path = ":memory:"): T {
  const db = openTwinDatabase(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("driver (F-703)", () => {
  it("is backed by node:sqlite — better-sqlite3 never enters the module cache", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      db.prepare("INSERT INTO t (name) VALUES (?)").run("a");
      const row = db.prepare("SELECT name FROM t WHERE id = ?").get(1) as { name: string };
      expect(row.name).toBe("a");
    });
    // node:sqlite is a builtin: opening a database registers it in
    // process.moduleLoadList ("NativeModule sqlite") and pulls nothing
    // from node_modules — better-sqlite3 must be absent from the CJS cache.
    // moduleLoadList is real but undocumented, so @types/node omits it.
    const { moduleLoadList } = process as unknown as { moduleLoadList: string[] };
    expect(moduleLoadList).toContain("NativeModule sqlite");
    const require = createRequire(import.meta.url);
    const nativeDriver = Object.keys(require.cache ?? {}).filter((path) =>
      path.includes("better-sqlite3")
    );
    expect(nativeDriver).toEqual([]);
  });
});

describe("openTwinDatabase", () => {
  it("opens an in-memory database and round-trips rows", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      db.prepare("INSERT INTO t (name) VALUES (?)").run("a");
      const row = db.prepare("SELECT name FROM t WHERE id = 1").get() as { name: string };
      expect(row.name).toBe("a");
    });
  });

  it("applies the twin pragmas: busy_timeout, foreign_keys", () => {
    withDb((db) => {
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });
  });

  it("uses WAL journal mode for file-backed databases", () => {
    const path = join(tmp, "wal", "twin.db");
    withDb((db) => {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    }, path);
  });

  it("creates missing parent directories for file paths", () => {
    const path = join(tmp, "deep", "nested", "twin.db");
    withDb((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    }, path);
    expect(existsSync(path)).toBe(true);
  });

  it("runs the migrate hook at open", () => {
    const db = openTwinDatabase(":memory:", {
      migrate: (d) => d.exec("CREATE TABLE migrated (id INTEGER PRIMARY KEY)"),
    });
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrated'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("migrated");
    } finally {
      db.close();
    }
  });

  it("enforces foreign keys (pragma is live, not just reported)", () => {
    withDb((db) => {
      db.exec(
        "CREATE TABLE parent (id INTEGER PRIMARY KEY);" +
          "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));"
      );
      expect(() => db.prepare("INSERT INTO child (parent_id) VALUES (999)").run()).toThrow();
    });
  });
});

describe("statement run() result (F-682)", () => {
  it("reports changes and lastInsertRowid — the shape node:sqlite also returns (F-703)", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const inserted = db.prepare("INSERT INTO t (name) VALUES (?)").run("a");
      expect(Number(inserted.lastInsertRowid)).toBe(1);
      expect(inserted.changes).toBe(1);
      const deleted = db.prepare("DELETE FROM t WHERE name = ?").run("missing");
      expect(deleted.changes).toBe(0);
    });
  });
});

describe("transaction()", () => {
  it("has the better-sqlite3 shape: transaction(fn) returns a callable that commits", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const insertMany = db.transaction((names: string[]) => {
        for (const name of names) db.prepare("INSERT INTO t (name) VALUES (?)").run(name);
        return names.length;
      });
      const count = insertMany(["a", "b", "c"]);
      expect(count).toBe(3);
      const row = db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
      expect(row.n).toBe(3);
    });
  });

  it("rolls back every statement when the wrapped function throws", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const failing = db.transaction(() => {
        db.prepare("INSERT INTO t (name) VALUES (?)").run("kept?");
        throw new Error("boom");
      });
      expect(() => failing()).toThrow("boom");
      const row = db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
      expect(row.n).toBe(0);
    });
  });

  it("nests like better-sqlite3: inner transactions join via savepoint, inner failure rolls back only inner work (github's seed nests createIssue)", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const inner = db.transaction((name: string) => {
        db.prepare("INSERT INTO t (name) VALUES (?)").run(name);
      });
      const failingInner = db.transaction(() => {
        db.prepare("INSERT INTO t (name) VALUES (?)").run("inner-rolled-back");
        throw new Error("inner boom");
      });
      const outer = db.transaction(() => {
        db.prepare("INSERT INTO t (name) VALUES (?)").run("outer");
        inner.immediate("inner");
        try {
          failingInner();
        } catch {
          // Swallowed: the outer transaction keeps its own work.
        }
        return true;
      });
      expect(outer()).toBe(true);
      const rows = db.prepare("SELECT name FROM t ORDER BY id").all() as Array<{ name: string }>;
      expect(rows.map((row) => row.name)).toEqual(["outer", "inner"]);
    });
  });

  it("exposes the .immediate variant (BEGIN IMMEDIATE) github's domain runs mutations under (F-682)", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const insert = db.transaction((name: string) => {
        db.prepare("INSERT INTO t (name) VALUES (?)").run(name);
        return name;
      });
      expect(insert.immediate("a")).toBe("a");
      const row = db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
      expect(row.n).toBe(1);
    });
  });
});
