// SPDX-License-Identifier: Apache-2.0
// FDRS-634 — unit tests for the doctor check engine.
//
// Four checks, in order: config present+valid → twin reachable → routing →
// egress floor. The engine stops at the first failure so the report carries
// exactly ONE named cause + one concrete fix ("never a false success" wants
// one clear next step, not a wall of maybes).

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctorChecks } from "../../../src/doctor/checks.js";

const WIRED_AGENT = [
  'import { withPome } from "@pome-sh/adapter-claude-sdk";',
  "withPome();",
  'const baseUrl = process.env.POME_GITHUB_REST_URL ?? "http://127.0.0.1:3333";',
  "export { baseUrl };",
].join("\n");

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-doctor-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

const VALID_CONFIG = JSON.stringify({ agent: { slug: "test-agent", framework: "claude" }, command: "npx tsx src/agent.ts" });

describe("runDoctorChecks", () => {
  it("fails the config check when no pome manifest exists, pointing at pome init", async () => {
    const dir = await repo({ "src/agent.ts": WIRED_AGENT });

    const report = await runDoctorChecks({ cwd: dir });
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: "config", status: "fail" });
    expect(report.checks[0]!.cause).toContain("pome.json");
    expect(report.checks[0]!.fix).toContain("pome init");
  });

  it("fails the config check on unparseable JSON, naming the file", async () => {
    const dir = await repo({
      "pome.json": "{ not json",
      "src/agent.ts": WIRED_AGENT,
    });

    const report = await runDoctorChecks({ cwd: dir });
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: "config", status: "fail" });
    expect(report.checks[0]!.cause).toContain("pome.json");
  });

  it("passes all four checks on a correctly wired repo", async () => {
    const dir = await repo({
      "pome.json": VALID_CONFIG,
      "src/agent.ts": WIRED_AGENT,
    });

    const report = await runDoctorChecks({ cwd: dir, env: {} });
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "config:pass",
      "twin:pass",
      "routing:pass",
      "egress:pass",
    ]);
    expect(report.ok).toBe(true);
  }, 30_000);

  it("fails routing on a hardcoded production host with file:line cause and env-read fix", async () => {
    const dir = await repo({
      "pome.json": VALID_CONFIG,
      "src/agent.ts": [
        'import fetch from "node-fetch";',
        'const gh = "https://api.github.com";',
        "export { gh };",
      ].join("\n"),
    });

    const report = await runDoctorChecks({ cwd: dir, env: {} });
    expect(report.ok).toBe(false);
    const routing = report.checks.at(-1)!;
    expect(routing).toMatchObject({ id: "routing", status: "fail" });
    expect(routing.cause).toContain("src/agent.ts");
    expect(routing.cause).toContain("line 2");
    expect(routing.cause).toContain("api.github.com");
    expect(routing.cause).toContain("POME_GITHUB_REST_URL");
    expect(routing.fix).toContain("POME_GITHUB_REST_URL");
    // Engine stopped at the failure — egress never ran.
    expect(report.checks.map((c) => c.id)).toEqual(["config", "twin", "routing"]);
  }, 30_000);

  it("fails routing when no wiring evidence exists at all", async () => {
    const dir = await repo({
      "pome.json": VALID_CONFIG,
      "src/agent.ts": "export const nothing = 1;",
    });

    const report = await runDoctorChecks({ cwd: dir, env: {} });
    expect(report.ok).toBe(false);
    const routing = report.checks.at(-1)!;
    expect(routing).toMatchObject({ id: "routing", status: "fail" });
    expect(routing.fix).toContain("withPome");
  }, 30_000);

  it("skips the local twin boot in hosted mode but still gates config/routing/egress", async () => {
    const dir = await repo({
      "pome.json": VALID_CONFIG,
      "src/agent.ts": WIRED_AGENT,
    });

    const report = await runDoctorChecks({ cwd: dir, env: {}, mode: "hosted" });
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "config:pass",
      "routing:pass",
      "egress:pass",
    ]);
    expect(report.ok).toBe(true);
  });

  it("fails the egress check when a wildcard disables the floor", async () => {
    const dir = await repo({
      "pome.json": VALID_CONFIG,
      "src/agent.ts": WIRED_AGENT,
    });

    const report = await runDoctorChecks({ cwd: dir, env: { POME_EGRESS_ALLOW: "*" } });
    expect(report.ok).toBe(false);
    const egress = report.checks.at(-1)!;
    expect(egress).toMatchObject({ id: "egress", status: "fail" });
    expect(egress.cause).toContain("POME_EGRESS_ALLOW");
    expect(egress.fix).toContain("*");
  }, 30_000);
});
