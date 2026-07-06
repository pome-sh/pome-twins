// SPDX-License-Identifier: Apache-2.0
import {
  createGitHubCloneApp as createBundledGitHubCloneApp,
  defaultSeedState,
  GitHubDomain,
  openGitHubCloneDatabase as openBundledGitHubCloneDatabase,
} from "@pome-sh/twin-github";

// Return type is pinned to `unknown` (every caller casts to its own view of the
// app) so tsc does not try to name the bundled twin's Hono app type in this
// module's emitted declarations — that inferred type references the vendored
// `@pome-sh/twin-github` copy of hono and is not portable (TS2742).
export async function createGitHubCloneApp(options?: Record<string, unknown>): Promise<unknown> {
  return createBundledGitHubCloneApp(options);
}

export async function openGitHubCloneDatabase(path?: string): Promise<unknown> {
  return openBundledGitHubCloneDatabase(path);
}

export async function seedGitHubCloneDatabase(db: unknown, seed?: unknown) {
  const resolvedSeed = seed === undefined ? defaultSeedState() : seed;
  new GitHubDomain(db as never).seed(resolvedSeed as never);
}

export async function exportGitHubCloneState(db: unknown) {
  return new GitHubDomain(db as never).exportState();
}
