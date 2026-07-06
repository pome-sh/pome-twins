// SPDX-License-Identifier: Apache-2.0
/**
 * Layer-3 defense for compile-seeds: boot an in-memory twin and load the
 * generated seed through its real `GitHubDomain.seed()` path. Catches the
 * cross-reference and domain-invariant errors that schema validation alone
 * cannot — e.g. issue.labels referencing a label not in repo.labels, PR head
 * referencing a branch with no files.
 *
 * Throws if the twin rejects the seed; otherwise returns silently.
 */
import { GitHubDomain, openGitHubCloneDatabase } from "@pome-sh/twin-github";

export function verifySeedWithTwin(seed: unknown): void {
  // `:memory:` SQLite — torn down when this function returns and `db`
  // goes out of scope. No filesystem side-effects, no cleanup needed.
  const db = openGitHubCloneDatabase(":memory:");
  try {
    new GitHubDomain(db).seed(seed as never);
  } catch (err) {
    throw new Error(
      `Seed verification failed: the in-memory twin rejected the compiled seed. ` +
        `Adjust the prose to fix the underlying problem.\n  ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
