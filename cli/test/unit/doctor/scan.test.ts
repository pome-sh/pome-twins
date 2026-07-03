// SPDX-License-Identifier: Apache-2.0
// FDRS-634 — unit tests for the doctor's static routing scan.
//
// The scan is the named-cause half of the routing check: it finds hardcoded
// production API hosts (file:line) that would bypass the POME_*_REST_URL env
// contract, and collects positive wiring evidence (env-var reads / adapter
// import). The dynamic half — requests observably reaching the twin — is
// what `pome run`'s trace records; doctor stays fast and LLM-free.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanAgentSources } from "../../../src/doctor/scan.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-doctor-scan-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

describe("scanAgentSources", () => {
  it("finds a hardcoded production host with file and line", async () => {
    const dir = await fixture({
      "src/agent/triage.ts": [
        'import fetch from "node-fetch";',
        "",
        'const gh = "https://api.github.com";',
        "export const x = 1;",
      ].join("\n"),
    });

    const result = await scanAgentSources(dir);
    expect(result.hardcoded).toEqual({
      file: "src/agent/triage.ts",
      line: 3,
      host: "api.github.com",
      envVar: "POME_GITHUB_REST_URL",
    });
  });

  it("maps stripe and slack production hosts to their env vars", async () => {
    const stripe = await fixture({ "a.ts": 'fetch("https://api.stripe.com/v1/charges");' });
    expect((await scanAgentSources(stripe)).hardcoded?.envVar).toBe("POME_STRIPE_REST_URL");

    const slack = await fixture({ "b.ts": 'fetch("https://hooks.slack.com/services/T0/B0/x");' });
    expect((await scanAgentSources(slack)).hardcoded?.envVar).toBe("POME_SLACK_REST_URL");
  });

  it("ignores hosts that only appear in comments", async () => {
    const dir = await fixture({
      "src/index.ts": [
        "// in production this would call https://api.github.com",
        " * docs: https://api.github.com/repos",
        'const base = process.env.POME_GITHUB_REST_URL ?? "http://127.0.0.1:3333";',
      ].join("\n"),
    });

    const result = await scanAgentSources(dir);
    expect(result.hardcoded).toBeNull();
    expect(result.wiring.envVar).toBe("POME_GITHUB_REST_URL");
  });

  it("does not flag loopback fallback URLs", async () => {
    const dir = await fixture({
      "src/index.ts": 'const url = process.env.POME_GITHUB_MCP_URL ?? "http://127.0.0.1:3333/s/demo/mcp";',
    });

    const result = await scanAgentSources(dir);
    expect(result.hardcoded).toBeNull();
    expect(result.wiring.envVar).toBe("POME_GITHUB_MCP_URL");
  });

  it("collects adapter-import evidence", async () => {
    const dir = await fixture({
      "src/index.ts": [
        'import { withPome, tool, query } from "@pome-sh/adapter-claude-sdk";',
        "withPome();",
      ].join("\n"),
    });

    const result = await scanAgentSources(dir);
    expect(result.wiring.adapterImport).toBe(true);
  });

  it("skips node_modules and non-code files", async () => {
    const dir = await fixture({
      "node_modules/evil/index.js": 'fetch("https://api.github.com");',
      "README.md": "call https://api.github.com",
      "src/ok.ts": "export const ok = process.env.POME_GITHUB_REST_URL;",
    });

    const result = await scanAgentSources(dir);
    expect(result.hardcoded).toBeNull();
    expect(result.filesScanned).toBe(1);
  });
});
