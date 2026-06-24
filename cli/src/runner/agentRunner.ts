// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";

export type AgentRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

export async function runAgentCommand(input: {
  command: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  preflight?: boolean;
}): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    const inheritAllEnv = process.env.POME_INHERIT_AGENT_ENV === "1";
    const useShell = process.env.POME_TRUST_AGENT_COMMAND === "1";
    const childEnv = buildAgentEnv(input.env, inheritAllEnv, Boolean(input.preflight));
    const command = useShell ? null : splitCommand(input.command);
    if (!useShell && !command) {
      resolve({
        stdout: "",
        stderr: "Could not parse agent command. Use POME_TRUST_AGENT_COMMAND=1 to run it through a shell.\n",
        exitCode: 2,
        timedOut: false,
      });
      return;
    }
    if (useShell) {
      console.warn("[pome] POME_TRUST_AGENT_COMMAND=1: running agent command through a shell.");
    }
    if (inheritAllEnv) {
      console.warn("[pome] POME_INHERIT_AGENT_ENV=1: passing the full parent environment to the agent.");
    }

    const child = useShell
      ? spawn(input.command, {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      })
      : spawn(command!.file, command!.args, {
        shell: false,
      stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, input.timeoutSeconds * 1000);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `${stderr}${error.message}\n`,
        exitCode: 2,
        timedOut,
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

const SAFE_PARENT_ENV = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "COMSPEC",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
]);

const DEFAULT_AGENT_ENV_ALLOWLIST = new Set([
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
]);

function buildAgentEnv(inputEnv: Record<string, string>, inheritAll: boolean, preflight: boolean): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  if (inheritAll) {
    Object.assign(base, process.env);
  } else {
    for (const key of [...SAFE_PARENT_ENV, ...DEFAULT_AGENT_ENV_ALLOWLIST]) {
      const value = process.env[key];
      if (value !== undefined) base[key] = value;
    }
    for (const key of (process.env.POME_AGENT_ENV_ALLOWLIST ?? "").split(",")) {
      const trimmed = key.trim();
      if (!trimmed) continue;
      const value = process.env[trimmed];
      if (value !== undefined) base[trimmed] = value;
    }
  }
  return {
    ...base,
    ...inputEnv,
    ...(preflight ? { POME_PREFLIGHT: "1" } : {}),
  };
}

function splitCommand(command: string): { file: string; args: string[] } | null {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote) return null;
  if (current.length > 0) parts.push(current);
  const [file, ...args] = parts;
  return file ? { file, args } : null;
}
