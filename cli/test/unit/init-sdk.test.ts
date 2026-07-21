import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/main.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("pome init --sdk", () => {
  it("--sdk claude scaffolds the Claude Agent SDK starter and sets agent.framework", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pome-init-sdk-"));
    tempDirs.push(projectDir);
    process.chdir(projectDir);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync([
      "node",
      "pome",
      "init",
      "--sdk",
      "claude",
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync("examples/agents/claude-sdk-agent.ts")).toBe(true);
    const agentSource = readFileSync("examples/agents/claude-sdk-agent.ts", "utf8");
    expect(agentSource).toContain('@pome-sh/adapter-claude-sdk');
    expect(agentSource).toContain("withPome()");
    expect(agentSource).toContain("POME_GITHUB_REST_URL");

    const cfg = JSON.parse(readFileSync("pome.json", "utf8")) as {
      agent: { framework?: string }; command?: string;
    };
    expect(cfg.agent.framework).toBe("claude");
    expect(cfg.command).toBe(
      "npx tsx examples/agents/claude-sdk-agent.ts",
    );
  });

  it("rejects unknown --sdk values with a clear error and non-zero exit", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pome-init-sdk-bad-"));
    tempDirs.push(projectDir);
    process.chdir(projectDir);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync([
      "node",
      "pome",
      "init",
      "--sdk",
      "made-up",
    ]);

    expect(process.exitCode).toBe(2);
    const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toContain('Unknown --sdk value "made-up"');
    // Validation happens before any filesystem writes.
    expect(existsSync("pome.json")).toBe(false);
    expect(existsSync("scenarios")).toBe(false);
    expect(existsSync("runs")).toBe(false);
    expect(existsSync("examples/agents/claude-sdk-agent.ts")).toBe(false);
    process.exitCode = 0;
  });

  it("--sdk claude-managed exits non-zero with the deferral message and writes no scaffold", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pome-init-sdk-managed-"));
    tempDirs.push(projectDir);
    process.chdir(projectDir);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync([
      "node",
      "pome",
      "init",
      "--sdk",
      "claude-managed",
    ]);

    expect(process.exitCode).toBe(2);
    const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toContain("Claude Managed Agent is not yet supported");
    // The deferred SDK is rejected before starter files/directories are copied.
    expect(existsSync("pome.json")).toBe(false);
    expect(existsSync("scenarios")).toBe(false);
    expect(existsSync("runs")).toBe(false);
    expect(existsSync("examples/agents/claude-sdk-agent.ts")).toBe(false);
    process.exitCode = 0;
  });

  it("plain `pome init` (no --sdk) still scaffolds the scripted agent and omits agent.framework", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pome-init-plain-"));
    tempDirs.push(projectDir);
    process.chdir(projectDir);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "pome", "init"]);

    const cfg = JSON.parse(readFileSync("pome.json", "utf8")) as {
      agent: { framework?: string }; command?: string;
    };
    expect(cfg.agent.framework).toBeUndefined();
    expect(cfg.command).toBe(
      "npx tsx examples/agents/scripted-triage-agent.ts",
    );
  });

  it("rerunning a plain project with --sdk claude upgrades agent.framework/command", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pome-init-sdk-upgrade-"));
    tempDirs.push(projectDir);
    process.chdir(projectDir);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "pome", "init"]);
    await createProgram().parseAsync([
      "node",
      "pome",
      "init",
      "--sdk",
      "claude",
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    const cfg = JSON.parse(readFileSync("pome.json", "utf8")) as {
      agent: { framework?: string }; command?: string;
    };
    expect(cfg.agent.framework).toBe("claude");
    expect(cfg.command).toBe(
      "npx tsx examples/agents/claude-sdk-agent.ts",
    );
    expect(existsSync("examples/agents/claude-sdk-agent.ts")).toBe(true);
  });
});
