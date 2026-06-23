// SPDX-License-Identifier: Apache-2.0
import {
  createGitHubCloneApp as createBundledGitHubCloneApp,
  defaultSeedState,
  GitHubDomain,
  openGitHubCloneDatabase as openBundledGitHubCloneDatabase,
} from "../twin-github/index.js";

export async function createGitHubCloneApp(options?: Record<string, unknown>) {
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
