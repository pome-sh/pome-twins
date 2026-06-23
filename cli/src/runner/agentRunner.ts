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
    const child = spawn(input.command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...input.env,
        ...(input.preflight ? { POME_PREFLIGHT: "1" } : {})
      }
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

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
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}
