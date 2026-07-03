// SPDX-License-Identifier: Apache-2.0
// FDRS-634 — the doctor check engine: config → twin → routing → egress, in
// order, stopping at the first failure so the report carries exactly ONE
// named cause and one concrete fix. "Never a false success": a wall of
// maybes hides the next step; one cause names it.
//
// The engine is deliberately separate from the `pome doctor` command so
// `pome run` can reuse it as a preflight gate (FDRS-641). Checks are written
// against the generic twin surface (bootTwin / the sdk's `/_pome/health`
// route contract) — twin internals are the architecture refactor's
// construction zone and stay untouched.

import { serve } from "@hono/node-server";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, relative } from "node:path";
import { sign } from "hono/jwt";
import { buildEgressAllowlist } from "../capture-server/egress.js";
import { findProjectConfigPath, readProjectConfig } from "../cli/project-config.js";
import { getAvailablePort } from "../runner/ports.js";
import { scanAgentSources } from "./scan.js";

export type DoctorCheckId = "config" | "twin" | "routing" | "egress";

export interface DoctorCheck {
  id: DoctorCheckId;
  status: "pass" | "fail";
  label: string;
  detail?: string; // short suffix on a pass line, e.g. "github · local"
  cause?: string; // fail only — the ONE named cause
  fix?: string; // fail only — the ONE concrete fix (may be multi-line)
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface RunDoctorChecksOptions {
  cwd?: string;
  // Injectable for tests; defaults to process.env. Read by the egress check
  // (floor wildcard) — NOT forwarded to any agent.
  env?: Record<string, string | undefined>;
  // "full" (default, `pome doctor` + local-run gate) boots the local twin.
  // "hosted" (the hosted-run gate, FDRS-641) skips the local twin boot: a
  // hosted run never touches it — the cloud provisions the session twin —
  // and the local boot needs better-sqlite3, unavailable under the Bun
  // runtime hosted runs commonly use. Config/routing/egress still gate.
  mode?: "full" | "hosted";
}

export async function runDoctorChecks(
  options: RunDoctorChecksOptions = {},
): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const mode = options.mode ?? "full";

  const checks: DoctorCheck[] = [];
  const steps: Array<(configDir: string) => Promise<DoctorCheck>> = [
    ...(mode === "full" ? [(dir: string) => checkTwinReachable(dir)] : []),
    (dir) => checkRouting(dir),
    async (dir) => checkEgressFloor(env, dir),
  ];

  const config = await checkConfig(cwd);
  checks.push(config);
  if (config.status === "fail") return { ok: false, checks };
  const configDir = config.configDir!;

  for (const step of steps) {
    const result = await step(configDir);
    checks.push(result);
    if (result.status === "fail") return { ok: false, checks };
  }

  return { ok: true, checks };
}

type ConfigCheck = DoctorCheck & { configDir?: string };

async function checkConfig(cwd: string): Promise<ConfigCheck> {
  const path = await findProjectConfigPath(cwd);
  if (!path) {
    return {
      id: "config",
      status: "fail",
      label: "pome.config.json not found",
      cause: `no pome.config.json found in ${cwd} or any parent directory.`,
      fix: "run pome init to scaffold one, then re-run pome doctor",
    };
  }

  let read;
  try {
    read = await readProjectConfig(cwd);
  } catch {
    read = null;
  }
  if (!read) {
    return {
      id: "config",
      status: "fail",
      label: "pome.config.json is not valid",
      cause: `${path} exists but is not parseable JSON.`,
      fix: "fix the JSON (or delete the file and run pome init), then re-run pome doctor",
    };
  }

  const command = read.config.agent?.command;
  if (command !== undefined && (typeof command !== "string" || command.trim().length === 0)) {
    return {
      id: "config",
      status: "fail",
      label: "pome.config.json is not valid",
      cause: `${path} has an agent.command that is not a non-empty string.`,
      fix: 'set agent.command to the command that starts your agent, e.g. "bun run src/index.ts"',
    };
  }

  return {
    id: "config",
    status: "pass",
    label: "pome.config.json found",
    configDir: dirname(read.path),
  };
}

// Boot the github twin in-process, serve it on an ephemeral loopback port,
// and walk the same path an agent would: the root health route, then the
// bearer-authed session health route with a freshly minted JWT.
async function checkTwinReachable(_configDir: string): Promise<DoctorCheck> {
  const fail = (cause: string): DoctorCheck => ({
    id: "twin",
    status: "fail",
    label: "twin not reachable",
    cause,
    fix: "bun install (twin dependencies), then re-run pome doctor — if it persists, file an issue with the error above",
  });

  let harness;
  try {
    // Dynamic import: the twin harness pulls in better-sqlite3, which the
    // hosted-mode gate must never load (unavailable under the Bun runtime).
    const { bootTwin } = await import("../twin/twinHarness.js");
    harness = await bootTwin({
      twin: "github",
      seedState: undefined,
      runId: `doctor_${randomUUID()}`,
    });
  } catch (err) {
    return fail(`the github twin failed to boot locally: ${firstLine(err)}`);
  }

  let server: { close: () => void } | null = null;
  try {
    const port = await getAvailablePort();
    server = serve({ fetch: harness.app.fetch, port, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/healthz`);
    if (!health.ok) {
      return fail(`the twin's health route answered ${health.status} at ${base}/healthz.`);
    }

    const sid = `doctor_${randomUUID()}`;
    const authSecret = process.env.TWIN_AUTH_SECRET ?? randomBytes(32).toString("hex");
    process.env.TWIN_AUTH_SECRET = authSecret;
    const token = await sign(
      { sid, team_id: "tm_local", login: "pome-agent", exp: Math.floor(Date.now() / 1000) + 120 },
      authSecret,
    );
    const sessionHealth = await fetch(`${base}/s/${sid}/_pome/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!sessionHealth.ok) {
      return fail(
        `the twin is up but rejected the session route (${sessionHealth.status} at /s/<sid>/_pome/health) — the auth contract the agent relies on is broken.`,
      );
    }

    return { id: "twin", status: "pass", label: "twin reachable", detail: "github · local" };
  } catch (err) {
    return fail(`could not reach the locally served twin: ${firstLine(err)}`);
  } finally {
    server?.close();
    harness.close();
  }
}

async function checkRouting(configDir: string): Promise<DoctorCheck> {
  const scan = await scanAgentSources(configDir);

  if (scan.hardcoded) {
    const { file, line, host, envVar } = scan.hardcoded;
    return {
      id: "routing",
      status: "fail",
      label: "requests are not routed to the twin",
      cause: `${file} reads from a hardcoded https://${host} on line ${line}, ignoring ${envVar} — so its requests would bypass the twin.`,
      fix: [
        "read the base URL from the env the runner injects —",
        `const { ${envVar}: baseUrl } = process.env`,
        "then re-run pome doctor",
      ].join("\n"),
    };
  }

  if (scan.wiring.envVar === null && !scan.wiring.adapterImport) {
    return {
      id: "routing",
      status: "fail",
      label: "requests are not routed to the twin",
      cause: `no POME_*_REST_URL / POME_*_MCP_URL read and no @pome-sh adapter found in the ${scan.filesScanned} source file(s) under ${relative(process.cwd(), configDir) || "."} — the agent has no path to the twin.`,
      fix: [
        'wire the adapter: import { withPome } from "@pome-sh/adapter-claude-sdk"; call withPome() at startup;',
        "read the twin base URL from POME_GITHUB_REST_URL (injected by the runner) — or run pome install to have your coding agent wire it.",
      ].join("\n"),
    };
  }

  return {
    id: "routing",
    status: "pass",
    label: "requests route to the twin",
    detail: scan.wiring.envVar ? `reads ${scan.wiring.envVar}` : "withPome() installed",
  };
}

function checkEgressFloor(
  env: Record<string, string | undefined>,
  _configDir: string,
): DoctorCheck {
  const patterns = buildEgressAllowlist(env);
  if (patterns.includes("*")) {
    return {
      id: "egress",
      status: "fail",
      label: "egress floor disabled",
      cause:
        "the egress floor is disabled — a `*` wildcard in POME_EGRESS_ALLOW allows every host, so a stray production call would pass through silently.",
      fix: "remove `*` from POME_EGRESS_ALLOW (list specific hosts instead), then re-run pome doctor",
    };
  }
  return {
    id: "egress",
    status: "pass",
    label: "egress floor active",
    detail: `deny-by-default · ${patterns.length} pattern(s) + loopback`,
  };
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? message;
}
