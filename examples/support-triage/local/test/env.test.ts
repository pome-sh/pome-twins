// SPDX-License-Identifier: Apache-2.0
// Guards the launch env contract: the examinee reads its twin wiring from the
// platform-convention vars (POME_GITHUB_MCP_URL / POME_SLACK_MCP_URL /
// POME_AUTH_TOKEN, plus optional POME_TASK), and fails loudly naming every
// missing var so a mis-assembled launch dies in preflight, not mid-run. Run
// with `npm test`.
import { describe, expect, it } from "vitest";
import { resolveTwinWiring } from "../src/index.ts";

const FULL_ENV = {
  POME_GITHUB_MCP_URL: "http://127.0.0.1:4001/s/sess_1/mcp",
  POME_SLACK_MCP_URL: "http://127.0.0.1:4002/s/sess_1/mcp",
  POME_AUTH_TOKEN: "bearer-jwt",
};

describe("resolveTwinWiring", () => {
  it("maps the per-twin MCP URLs and the shared bearer through untouched", () => {
    const wiring = resolveTwinWiring({ ...FULL_ENV });
    expect(wiring.githubMcpUrl).toBe(FULL_ENV.POME_GITHUB_MCP_URL);
    expect(wiring.slackMcpUrl).toBe(FULL_ENV.POME_SLACK_MCP_URL);
    expect(wiring.authToken).toBe("bearer-jwt");
  });

  it("prefers POME_TASK as the kickoff prompt when set", () => {
    const wiring = resolveTwinWiring({ ...FULL_ENV, POME_TASK: "  triage the report  " });
    expect(wiring.task).toBe("triage the report");
  });

  it("falls back to the bundled duplicate-issue kickoff prompt when POME_TASK is unset", () => {
    const wiring = resolveTwinWiring({ ...FULL_ENV });
    expect(wiring.task).toContain("#support");
    expect(wiring.task).toContain("acme/orders-service");
  });

  it("fails loudly, naming every missing var, when the env is empty", () => {
    expect(() => resolveTwinWiring({})).toThrow(/POME_GITHUB_MCP_URL/);
    expect(() => resolveTwinWiring({})).toThrow(/POME_SLACK_MCP_URL/);
    expect(() => resolveTwinWiring({})).toThrow(/POME_AUTH_TOKEN/);
  });

  it("lists only the var that is actually missing", () => {
    const env = { ...FULL_ENV } as Record<string, string>;
    delete env.POME_SLACK_MCP_URL;
    expect(() => resolveTwinWiring(env)).toThrow(
      /Missing twin wiring in the environment: POME_SLACK_MCP_URL\./
    );
  });
});
