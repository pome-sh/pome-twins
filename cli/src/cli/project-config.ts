// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { HostedOrchError } from "../hosted/errors.js";

export const CONFIG_FILE = "pome.config.json";

export interface ProjectConfig {
  agent?: {
    command?: unknown;
    sdk?: unknown;
    [key: string]: unknown;
  };
  agentId?: unknown;
  agentSlug?: unknown;
  [key: string]: unknown;
}

export interface ProjectConfigRead {
  path: string;
  config: ProjectConfig;
}

export async function findProjectConfigPath(
  startDir = process.cwd(),
): Promise<string | null> {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function readProjectConfig(
  startDir = process.cwd(),
): Promise<ProjectConfigRead | null> {
  const path = await findProjectConfigPath(startDir);
  if (!path) return null;
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE} is not a JSON object`);
  }
  return { path, config: parsed as ProjectConfig };
}

export async function readRequiredProjectConfig(
  startDir = process.cwd(),
): Promise<ProjectConfigRead> {
  const read = await readProjectConfig(startDir);
  if (!read) {
    throw new HostedOrchError(`${CONFIG_FILE} not found. Run \`pome init\` first.`);
  }
  return read;
}

export async function writeProjectConfig(
  path: string,
  config: ProjectConfig,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function normalizeConfigAgentId(config: ProjectConfig): string | undefined {
  if (config.agentId === undefined) return undefined;
  if (typeof config.agentId !== "string") {
    throw new HostedOrchError(`${CONFIG_FILE} has malformed agentId; expected a string.`);
  }
  const trimmed = config.agentId.trim();
  if (!trimmed.startsWith("agt_")) {
    throw new HostedOrchError(
      `${CONFIG_FILE} has malformed agentId; expected an agt_ identifier.`,
    );
  }
  return trimmed;
}

export function normalizeConfigAgentSdk(config: ProjectConfig): string | null {
  const sdk = config.agent?.sdk;
  if (typeof sdk !== "string") return null;
  const trimmed = sdk.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeConfigAgentCommand(
  config: ProjectConfig,
): string | undefined {
  const command = config.agent?.command;
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
