// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { migrate } from "./migrations.js";
import type { GitHubTwinDatabase } from "../types.js";

export function openGitHubTwinDatabase(path = ":memory:"): GitHubTwinDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  migrate(db);
  return db;
}
