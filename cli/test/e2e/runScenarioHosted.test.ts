import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { sign as signJwt } from "hono/jwt";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "../../src/cli/main.ts");
// Absolute loader path: child cwd is a temp dir without node_modules/tsx.
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const TWIN_AUTH_SECRET = "test-secret-32-chars-minimum-length";

let cloudServer: ServerType | undefined;
let receivedResult: unknown = null;
let finalizeResponseOverrides: Record<string, unknown> = {};

async function startFakeCloud(): Promise<number> {
  const app = new Hono();
  let port = 0;
  app.post("/v1/sessions", async (c) => {
    const sid = "ses_e2e";
    const token = await signJwt(
      { sid, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) + 600 },
      TWIN_AUTH_SECRET
    );
    return c.json({
      session_id: sid,
      session_token: "pst_test_e2e",
      twin_url: `http://127.0.0.1:${port}/s/${sid}`,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      agent_token: token,
      openapi_url: `http://127.0.0.1:${port}/openapi.json`,
      per_twin: {},
    });
  });
  app.get("/s/:sid/_pome/state", (c) =>
    c.json({
      repositories: [
        {
          owner: "acme",
          name: "api",
          full_name: "acme/api",
          labels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
          issues: [{ number: 1, title: "x", labels: [{ name: "bug" }], assignee_login: null }],
        },
      ],
    })
  );
  app.get("/s/:sid/_pome/events", (c) => c.json([]));
  app.post("/v1/sessions/:id/finalize", async (c) => {
    receivedResult = await c.req.json();
    return c.json(
      {
        run_id: "run_e2e",
        score: 100,
        judge_model: "test-judge",
        dashboard_url: "http://127.0.0.1/runs/run_e2e",
        ...finalizeResponseOverrides,
      },
      201,
    );
  });
  app.delete("/v1/sessions/:id", (c) =>
    c.json({ id: c.req.param("id"), state: "expired" })
  );

  port = await new Promise<number>((res) => {
    cloudServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      res(info.port)
    );
  });
  return port;
}

describe("pome run --hosted (e2e via spawn)", () => {
  let tmp: string;
  let port: number;

  beforeEach(async () => {
    receivedResult = null;
    finalizeResponseOverrides = {};
    tmp = await mkdtemp(join(tmpdir(), "pome-e2e-"));
    // FDRS-641 — `pome run` gates on the doctor preflight (config present,
    // routing wired, egress floor; local twin boot is skipped on hosted
    // runs). Make tmp a wired repo and spawn the CLI from it, matching what
    // a real post-`pome install` project looks like.
    await writeFile(
      join(tmp, "pome.config.json"),
      JSON.stringify({ agent: { command: "true" } }, null, 2),
      "utf8"
    );
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(
      join(tmp, "src", "agent.ts"),
      "const baseUrl = process.env.POME_GITHUB_REST_URL;\nexport { baseUrl };\n",
      "utf8"
    );
    port = await startFakeCloud();
  });

  afterEach(async () => {
    cloudServer?.close();
    cloudServer = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it("exits 0, prints PASS + cloud dashboard URL, and never POSTs agent_stdout", async () => {
    const scenarioPath = join(tmp, "scn.md");
    // Trivially-passing scenario: 'no unsupported endpoint' + 'no new labels'
    // are true given empty events + identical state from the fake cloud.
    await writeFile(
      scenarioPath,
      [
        "# Trivial",
        "",
        "## Prompt",
        "Pretend prompt.",
        "",
        "## Success Criteria",
        "- [D] No unsupported endpoint was called",
        "- [D] No new labels were created",
        "",
        "## Config",
        "```yaml",
        "twins: [github]",
        "timeout: 30",
        "passThreshold: 100",
        "```",
        "",
      ].join("\n"),
      "utf8"
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_ENTRY,
        "run",
        scenarioPath,
        "--hosted",
        "--api-url",
        `http://127.0.0.1:${port}`,
        "--agent",
        "true",
        "--artifacts-dir",
        join(tmp, "runs"),
      ],
      {
        cwd: tmp,
        env: { ...process.env, POME_API_KEY: "pme_e2e_test" },
      }
    );

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdout.on("data", (d) => (stdout += d.toString()));
    const code = await new Promise<number>((res) => child.on("close", res));

    expect(code, `stderr was:\n${stderr}\nstdout was:\n${stdout}`).toBe(0);
    expect(stderr).toMatch(/PASS/);
    expect(stderr).toMatch(/cloud:\s+http/);

    // BYOK guard: agent_stdout never crosses the wire.
    expect(receivedResult).not.toBeNull();
    expect(receivedResult as Record<string, unknown>).not.toHaveProperty(
      "agent_stdout"
    );
  }, 90_000);

  it("prints UNEVAL when cloud score is 100 but returned criteria were skipped", async () => {
    finalizeResponseOverrides = {
      criteria_results: [
        {
          criterion: { type: "D", text: "No unsupported endpoint was called" },
          outcome: "skipped",
          passed: false,
          skipped: true,
          reason: "cloud could not evaluate this criterion",
        },
      ],
    };
    const scenarioPath = join(tmp, "scn.md");
    await writeFile(
      scenarioPath,
      [
        "# Trivial",
        "",
        "## Prompt",
        "Pretend prompt.",
        "",
        "## Success Criteria",
        "- [D] No unsupported endpoint was called",
        "",
        "## Config",
        "```yaml",
        "twins: [github]",
        "timeout: 30",
        "passThreshold: 100",
        "```",
        "",
      ].join("\n"),
      "utf8",
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI_ENTRY,
        "run",
        scenarioPath,
        "--api-url",
        `http://127.0.0.1:${port}`,
        "--agent",
        "true",
        "--artifacts-dir",
        join(tmp, "runs"),
      ],
      {
        cwd: tmp,
        env: { ...process.env, POME_API_KEY: "pme_e2e_test" },
      },
    );

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const code = await new Promise<number>((res) => child.on("close", res));

    expect(code, `stderr was:\n${stderr}`).toBe(0);
    expect(stderr).toMatch(/UNEVAL Trivial/);
    expect(stderr).toContain("score: un-evaluated (cannot pass)");
    expect(stderr).toContain("cloud score: 100/100");
  }, 90_000);
});
