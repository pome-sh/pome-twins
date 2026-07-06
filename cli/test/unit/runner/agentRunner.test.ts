import { afterEach, describe, expect, it } from "vitest";
import { runAgentCommand } from "../../../src/runner/agentRunner.js";

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "POME_INHERIT_AGENT_ENV",
  "POME_TRUST_AGENT_COMMAND",
  "POME_AGENT_ENV_ALLOWLIST",
  "SECRET_SHOULD_NOT_LEAK",
] as const;

function saveEnv() {
  for (const key of ENV_KEYS) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = SAVED_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("runAgentCommand", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("returns a controlled failure when the executable is missing", async () => {
    saveEnv();
    const result = await runAgentCommand({
      command: "pome-definitely-missing-agent-binary",
      env: {},
      timeoutSeconds: 1,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/ENOENT|not found|spawn/);
    expect(result.timedOut).toBe(false);
  });

  it("forwards documented provider keys without inheriting unrelated secrets", async () => {
    saveEnv();
    process.env.OPENAI_API_KEY = "sk-test-provider";
    // FDRS-667 — Claude subscription auth must reach the agent subprocess.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    process.env.SECRET_SHOULD_NOT_LEAK = "raw-secret";

    const result = await runAgentCommand({
      command: `${process.execPath} -e "process.stdout.write(JSON.stringify({ openai: process.env.OPENAI_API_KEY || null, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN || null, secret: process.env.SECRET_SHOULD_NOT_LEAK || null }))"`,
      env: {},
      timeoutSeconds: 5,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      openai: "sk-test-provider",
      oauth: "sk-ant-oat-test",
      secret: null,
    });
  });

  it("does not interpret shell metacharacters by default", async () => {
    saveEnv();
    const result = await runAgentCommand({
      command: `${process.execPath} -e "process.stdout.write(process.argv.slice(1).join(' '))" ";" "echo" "bad"`,
      env: {},
      timeoutSeconds: 5,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("; echo bad");
  });
});
