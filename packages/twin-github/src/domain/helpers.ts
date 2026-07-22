// SPDX-License-Identifier: Apache-2.0
import type { CommitRow } from "../types.js";
import { validationFailed } from "../errors.js";

/** Fork copies preserve everything about a commit except its (randomized) SHA. */
export function commitIdentityKey(commit: CommitRow): string {
  return [commit.message, commit.author_login, commit.committer_login, commit.tree_sha, commit.created_at].join("");
}

export function contentLineCount(content: string) {
  return Math.max(1, content.replace(/\n$/, "").split("\n").length);
}

export function normalizePath(path: string) {
  const normalized = path.replace(/^\/+/, "").replace(/\/+/g, "/").trim();
  if (normalized.includes("..")) validationFailed("path", "invalid", path);
  return normalized;
}
