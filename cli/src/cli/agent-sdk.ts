// SPDX-License-Identifier: Apache-2.0
// FDRS-661 — Claude Agent SDK access for the embedded (headless) wiring
// session: detect whether the user's own credentials exist, and lazily
// provision the SDK driver into ~/.pome/agent-sdk/<version>.
//
// The SDK is deliberately NOT a dependency of pomecli: its per-platform
// optionalDependency bundles the Claude Code runtime (~244 MB unpacked),
// which would sink `npx pomecli demo` cold-start. Instead we install the
// driver package alone (--omit=optional, a few MB) on first use, and point
// it at the user's already-installed `claude` binary via
// `pathToClaudeCodeExecutable` — verified against SDK 0.3.202 driving
// Claude Code 2.1.201.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Pinned driver version — bump deliberately, in lockstep with a re-test
 *  against the oldest Claude Code binary we expect on user machines. */
export const AGENT_SDK_VERSION = "0.3.202";

/** macOS keychain service Claude Code stores its `/login` credential under.
 *  Existence-only probe (no `-w`): the secret is never read or printed. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * True when the machine has credentials the Claude Code binary can
 * authenticate with on its own: a stored `/login` session (keychain or
 * `$CLAUDE_CONFIG_DIR/.credentials.json`) or an explicit env credential.
 * Mirrors the SDK's own resolution; pome never reads the secret values.
 */
export function detectClaudeLogin(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }

  const configDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  try {
    if (existsSync(join(configDir, ".credentials.json"))) return true;
  } catch {
    /* unreadable — treat as absent */
  }

  if (platform === "darwin") {
    try {
      const res = spawnSync(
        "security",
        ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE],
        { stdio: "ignore", timeout: 5000 },
      );
      if (res.status === 0) return true;
    } catch {
      /* lookup failed — treat as absent */
    }
  }

  return false;
}

/** Directory the pinned SDK driver is provisioned into. */
export function agentSdkDir(home: string = homedir()): string {
  return join(home, ".pome", "agent-sdk", AGENT_SDK_VERSION);
}

function sdkEntryPath(dir: string): string {
  return join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
}

export function isAgentSdkProvisioned(dir: string = agentSdkDir()): boolean {
  return existsSync(sdkEntryPath(dir));
}

/** Minimal structural view of the SDK's query() — the driver is loaded at
 *  runtime, so pome compiles against this shape, not the SDK's types. */
export type AgentSdkQueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

export interface AgentSdkModule {
  query: AgentSdkQueryFn;
}

/**
 * Install the pinned driver into `dir` using whichever package manager is
 * on PATH. `--omit=optional` skips the ~244 MB platform runtime — the
 * session runs on the user's own `claude` binary instead.
 * Returns null (with a printed reason) when no package manager is found
 * or the install fails; callers fall back to the interactive session.
 */
export async function provisionAgentSdk(dir: string = agentSdkDir()): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    await writeFile(manifest, JSON.stringify({ name: "pome-agent-sdk", private: true }, null, 2));
  }

  const spec = `@anthropic-ai/claude-agent-sdk@${AGENT_SDK_VERSION}`;
  const attempts: Array<[string, string[]]> = [
    ["npm", ["install", "--omit=optional", "--no-audit", "--no-fund", spec]],
    ["bun", ["add", "--omit=optional", spec]],
  ];

  for (const [bin, args] of attempts) {
    const probe = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000 });
    if (probe.error || probe.status !== 0) continue;
    console.error(`downloading the Claude Agent SDK driver (${spec}, a few MB, one-time) …`);
    const res = spawnSync(bin, args, { cwd: dir, stdio: "ignore", timeout: 300_000 });
    if (res.status === 0 && isAgentSdkProvisioned(dir)) return true;
    console.error(`(${bin} install of ${spec} failed)`);
  }

  console.error("couldn't provision the Claude Agent SDK driver (is npm or bun on PATH?).");
  return false;
}

/** Import the provisioned driver. Returns null when not provisioned. */
export async function loadAgentSdk(dir: string = agentSdkDir()): Promise<AgentSdkModule | null> {
  const entry = sdkEntryPath(dir);
  if (!existsSync(entry)) return null;
  const mod = (await import(pathToFileURL(entry).href)) as { query?: unknown };
  if (typeof mod.query !== "function") return null;
  return { query: mod.query as AgentSdkQueryFn };
}
