import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateSessionResponse } from "../../src/types/shared.js";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  resolveCredentials: vi.fn(),
}));

vi.mock("../../src/cli/credentials.js", () => ({
  resolveCredentials: mocks.resolveCredentials,
}));

vi.mock("../../src/cli/project-config.js", () => ({
  normalizeConfigAgentId: vi.fn(),
  readProjectConfig: vi.fn(async () => null),
}));

vi.mock("../../src/hosted/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hosted/client.js")>();
  return {
    ...actual,
    createHostedClient: vi.fn(() => ({
      createSession: mocks.createSession,
    })),
  };
});

import { runSessionCreate } from "../../src/cli/session.js";

const session: CreateSessionResponse = {
  session_id: "ses_test",
  session_token: "ses_test",
  twin_url: "https://twin.example.com/s/ses_test",
  expires_at: "2026-06-24T16:30:00.000Z",
  openapi_url: "https://twin.example.com/s/ses_test/openapi.json",
  agent_token: "agent_secret_token",
  per_twin: {
    github: {
      api_url: "https://twin.example.com/s/ses_test/github",
      mcp_url: "https://twin.example.com/s/ses_test/github/mcp",
      openapi_url: "https://twin.example.com/s/ses_test/github/openapi.json",
    },
    stripe: {
      api_url: "https://twin.example.com/s/ses_test/stripe",
      mcp_url: "https://twin.example.com/s/ses_test/stripe/mcp",
      openapi_url: "https://twin.example.com/s/ses_test/stripe/openapi.json",
    },
    slack: {
      api_url: "https://twin.example.com/s/ses_test/slack",
      mcp_url: "https://twin.example.com/s/ses_test/slack/mcp",
      openapi_url: "https://twin.example.com/s/ses_test/slack/openapi.json",
    },
  },
  provider_credentials: {
    github: {
      token: "github_secret_token",
      header: "Authorization",
      scheme: "Bearer",
    },
    stripe: {
      api_key: "stripe_secret_key",
      header: "Authorization",
      scheme: "Bearer",
    },
    slack: {
      token: "slack_secret_token",
      header: "Authorization",
      scheme: "Bearer",
    },
  },
};

describe("runSessionCreate secret output", () => {
  const originalExitCode = process.exitCode;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    mocks.resolveCredentials.mockResolvedValue({
      apiBaseUrl: "https://api.example.com",
      apiKey: "control_plane_secret",
    });
    mocks.createSession.mockResolvedValue(session);
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      stdout.push(String(msg));
    });
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      stderr.push(String(msg));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.resolveCredentials.mockReset();
    mocks.createSession.mockReset();
    process.exitCode = originalExitCode;
  });

  it("keeps JSON output redacted even when --show-secrets is set", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github"],
      showSecrets: true,
      format: "json",
    });

    const output = stdout.join("\n");
    expect(output).toContain("***redacted***");
    expect(output).not.toContain("agent_secret_token");
    expect(output).not.toContain("github_secret_token");
    expect(output).not.toContain("stripe_secret_key");
  });

  it("writes env exports only to a restricted secrets file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-session-"));
    const secretsFile = join(dir, "session.env");

    try {
      await runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["stripe"],
        showSecrets: false,
        format: "env",
        secretsFile,
      });

      const combinedOutput = [...stdout, ...stderr].join("\n");
      expect(combinedOutput).toContain(secretsFile);
      expect(combinedOutput).not.toContain("agent_secret_token");
      expect(combinedOutput).not.toContain("github_secret_token");
      expect(combinedOutput).not.toContain("stripe_secret_key");

      const contents = await readFile(secretsFile, "utf8");
      expect(contents).toContain("POME_AUTH_TOKEN=\"agent_secret_token\"");
      expect(contents).toContain("POME_STRIPE_API_KEY=\"stripe_secret_key\"");
      expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);
      expect(process.exitCode).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses env format without printing exports when no secrets file is provided", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github"],
      showSecrets: true,
      format: "env",
    });

    const combinedOutput = [...stdout, ...stderr].join("\n");
    expect(combinedOutput).toContain("Refusing to print environment exports");
    expect(combinedOutput).not.toContain("agent_secret_token");
    expect(combinedOutput).not.toContain("github_secret_token");
    expect(process.exitCode).toBe(2);
  });

  // ── Multi-twin (M3): slack allowed, repeated --twin, slack redaction, env ──
  it("allows the slack twin (MOUNTED_TWINS) and creates a session for it", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["slack"],
      showSecrets: false,
      format: "json",
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ twins: ["slack"] }),
    );
  });

  it("stands up a multi-twin session from repeated --twin values", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github", "slack"],
      showSecrets: false,
      format: "json",
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ twins: ["github", "slack"] }),
    );
  });

  it("de-dupes repeated twins and rejects an unknown twin", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github", "github"],
      showSecrets: false,
      format: "json",
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ twins: ["github"] }),
    );

    await expect(
      runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["linear"],
        showSecrets: false,
        format: "json",
      }),
    ).rejects.toThrow(/Unknown twin "linear"/);
  });

  it("redacts provider_credentials.slack.token in JSON output", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["slack"],
      showSecrets: true,
      format: "json",
    });
    const output = stdout.join("\n");
    expect(output).toContain("***redacted***");
    expect(output).not.toContain("slack_secret_token");
  });

  it("writes a slack env export with POME_SLACK_* and the JWT as the slack bearer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-session-slack-"));
    const secretsFile = join(dir, "session.env");
    try {
      await runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["github", "slack"],
        showSecrets: false,
        format: "env",
        secretsFile,
      });
      const contents = await readFile(secretsFile, "utf8");
      // Distinct per-twin endpoints, plus the slack bearer = the session JWT
      // (the proxy only verifies the JWT — never provider_credentials.slack.token).
      expect(contents).toContain(
        'POME_GITHUB_REST_URL="https://twin.example.com/s/ses_test/github"',
      );
      expect(contents).toContain(
        'POME_SLACK_REST_URL="https://twin.example.com/s/ses_test/slack"',
      );
      expect(contents).toContain(
        'POME_SLACK_MCP_URL="https://twin.example.com/s/ses_test/slack/mcp"',
      );
      expect(contents).toContain('POME_SLACK_TOKEN="agent_secret_token"');
      expect(contents).not.toContain("slack_secret_token");
      expect(contents).toContain('POME_TWIN_NAMES="github,slack"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
