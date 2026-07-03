#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { serve } from "@hono/node-server";
import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "hono/jwt";
import {
  readLatestRun,
  readMetaSummary,
} from "../recorder/artifacts.js";
import {
  LEGACY_EVENTS_MESSAGE,
  computeTraceHealth,
  readEventsJsonl,
  renderEvents,
  renderTraceHealth,
} from "../recorder/inspect.js";
import { runScenario } from "../runner/runScenario.js";
import { runScenarioHosted } from "../runner/runScenarioHosted.js";
import { runScoreLine, scoreStatus } from "../score/view.js";
import { HostedUsageError, exitCodeFor } from "../hosted/errors.js";
import { resolveCredentials, clearLocalCredentials } from "./credentials.js";
import { loginWithClerk } from "./login.js";
import { runDocsCommand } from "./docs.js";
import { runCompileSeeds } from "./compile-seeds.js";
import { runScenariosCommand } from "./scenarios.js";
import { runEvalCommand } from "./eval.js";
import { runSkillsInstall } from "./skills.js";
import {
  findTwin,
  runnableScenarios,
} from "./scenarios-catalog.js";
import {
  friendlyHostedError,
  runSessionCreate,
  runSessionList,
  runSessionStop,
  type SessionListStateFilter,
} from "./session.js";
import { runRegisterAgent } from "./register.js";
import { resolvePackageRoot } from "./resolve-package-root.js";
import {
  ClaudeManagedDeferredError,
  ClaudeSdkDeferredError,
  writeSdkScaffold,
} from "./init-sdk.js";
import {
  DEFAULT_CONTROL_PLANE_URL,
  DEFAULT_DASHBOARD_URL,
} from "./defaults.js";
import {
  CONFIG_FILE,
  normalizeConfigAgentCommand,
  readProjectConfig,
  writeProjectConfig,
  type ProjectConfig,
} from "./project-config.js";
import { createGitHubCloneApp, openGitHubCloneDatabase, seedGitHubCloneDatabase } from "../twin/githubCloneAdapter.js";
import { resolveAuthSecret } from "../twin-github/auth.js";
import { buildFixPrompt } from "../fix-prompt/index.js";
import { parseScenarioFile } from "../scenario/parseScenario.js";
import type { RecorderEvent } from "../types/shared.js";

const PACKAGE_VERSION = readPackageVersion();
const SESSION_CREATE_FORMATS = new Set(["text", "json", "env"]);
const DEFAULT_AGENT_COMMAND = "npx tsx examples/agents/scripted-triage-agent.ts";

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, "..", "..", "package.json"),
      resolve(here, "..", "..", "..", "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const raw = readFileSync(p, "utf8");
        const j = JSON.parse(raw) as { version?: string };
        if (typeof j.version === "string") return j.version;
      }
    }
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

export function createProgram() {
  const program = new Command();

  program
    .name("pome")
    .description(
      "Digital-twin testing for AI agents — `pome run` records to app.pome.sh. See `pome docs getting-started`.",
    )
    .version(PACKAGE_VERSION)
    .showHelpAfterError("(add --help for usage)");

  program
    .command("init")
    .description("Create starter Pome config and folders")
    .option(
      "--sdk <name>",
      "Scaffold for a specific agent SDK (claude | claude-managed). Adds the SDK-specific example file and pre-fills agent.sdk so the dashboard badges runs correctly.",
    )
    .action(async (opts: { sdk?: string }) => {
      const sdk = opts.sdk?.trim();
      if (
        sdk !== undefined &&
        sdk !== "claude" &&
        sdk !== "claude-managed"
      ) {
        console.error(
          `Unknown --sdk value "${opts.sdk}". Supported: claude, claude-managed.`,
        );
        process.exitCode = 2;
        return;
      }
      if (sdk === "claude-managed") {
        console.error(new ClaudeManagedDeferredError().message);
        process.exitCode = 2;
        return;
      }
      if (sdk === "claude") {
        // Deferred until @pome-sh/adapter-claude-sdk publishes to npm
        // (OSS Launch Stage 1). The scaffolded file would import a package
        // that 404s on `npm install`. Mirror the claude-managed short-circuit:
        // bail before touching the filesystem.
        console.error(new ClaudeSdkDeferredError().message);
        process.exitCode = 2;
        return;
      }

      await mkdir("scenarios", { recursive: true });
      await mkdir("examples/agents", { recursive: true });
      await mkdir("runs", { recursive: true });
      await copyStarterFiles();

      let agentBlock: ProjectConfig["agent"] = {
        command: DEFAULT_AGENT_COMMAND,
      };
      let postInitMessage =
        "Pome initialized.\n" +
        "Next steps:\n" +
        "  1. pome login                    # one-time, opens the dashboard to sign in\n" +
        "  2. pome register agent <name>    # scopes runs to this project (writes agentId + agentSlug to pome.config.json)\n" +
        "  3. pome run scenarios/01-bug-happy-path.md\n" +
        "\n" +
        "Optional follow-ups:\n" +
        "  - pome init --sdk claude         # scaffold a Claude Agent SDK starter (gated on @pome-sh/adapter-claude-sdk npm publish — see Stage 1)\n" +
        "  - pome scenarios stripe --copy   # add Stripe payment scenarios when needed\n" +
        "\n" +
        "See `pome docs getting-started` for a narrative walkthrough.";

      if (sdk) {
        try {
          const scaffold = await writeSdkScaffold(sdk);
          agentBlock = {
            sdk: scaffold.agentSdkValue,
            command: scaffold.agentCommand,
          };
          postInitMessage =
            `Pome initialized with --sdk ${sdk}. Scaffolded ${scaffold.exampleAgentRelativePath}.\n` +
            scaffold.postInstallHint;
        } catch (err) {
          if (err instanceof ClaudeManagedDeferredError) {
            console.error(err.message);
            process.exitCode = 2;
            return;
          }
          throw err;
        }
      }

      const existingConfig = await readProjectConfig(process.cwd());
      if (!existingConfig) {
        await writeProjectConfig(CONFIG_FILE, {
          agent: agentBlock,
          artifactsDir: "runs",
          passThreshold: 100,
        });
      } else if (sdk) {
        await writeProjectConfig(existingConfig.path, {
          ...existingConfig.config,
          agent: {
            ...(typeof existingConfig.config.agent === "object" &&
            existingConfig.config.agent !== null
              ? existingConfig.config.agent
              : {}),
            ...agentBlock,
          },
        });
      }
      console.error(postInitMessage);
    });

  program
    .command("login")
    .description("Sign in with Clerk and store a hosted team API key (macOS Keychain or ~/.pome/credentials.json)")
    .option(
      "--api-url <url>",
      "Control-plane base URL.",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option(
      "--dashboard-url <url>",
      "App URL for Clerk sign-in (must serve /cli/login).",
      process.env.POME_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
    )
    .option(
      "--key-name <name>",
      "Label for the API key minted by this login.",
      "pome login",
    )
    .action(
      async (options: { apiUrl: string; dashboardUrl: string; keyName: string }) => {
        await loginWithClerk(options);
      },
    );

  program
    .command("logout")
    .description("Remove locally stored hosted credentials (Keychain entry and/or ~/.pome/credentials.json)")
    .action(async () => {
      await clearLocalCredentials();
      console.error("Removed local Pome credentials.");
      console.error(
        "Server-side keys are not auto-revoked — revoke API keys from the dashboard if this device was lost.",
      );
    });

  program
    .command("docs")
    .argument("[topic]", "Topic id (e.g. getting-started, github, cli) — prints the docs.pome.sh URL")
    .option(
      "--site <origin>",
      "Override docs site origin (default https://docs.pome.sh)",
    )
    .option(
      "--url",
      "Print docs.pome.sh URLs (default behavior; retained for compatibility).",
      false,
    )
    .description(
      "Navigate canonical narrative docs on docs.pome.sh",
    )
    .action(async (topic: string | undefined, opts: { site?: string; url?: boolean }) => {
      await runDocsCommand(topic, { site: opts.site, urlOnly: Boolean(opts.url) });
    });

  program
    .command("scenarios")
    .argument(
      "[twin]",
      "Twin id (e.g. github). Omit to list available twins.",
    )
    .option(
      "--copy",
      "Copy the twin's runnable scenarios into the local project.",
      false,
    )
    .option(
      "--force",
      "With --copy, overwrite existing files in the destination.",
      false,
    )
    .option(
      "--dest <dir>",
      "With --copy, write into this directory instead of ./scenarios/.",
    )
    .description(
      "Browse the bundled scenarios library (or copy a twin's scenarios into the local project)",
    )
    .action(
      async (
        twin: string | undefined,
        opts: { copy: boolean; force: boolean; dest?: string },
      ) => {
        await runScenariosCommand(twin, {
          copy: opts.copy,
          force: opts.force,
          dest: opts.dest,
        });
      },
    );

  program
    .command("compile-seeds")
    .argument("[target]", "Scenario .md file or directory (defaults to ./scenarios)")
    .option("--force", "Recompile even if the sidecar's source hash matches", false)
    .option(
      "--hosted",
      "Compile via the Pome control plane instead of calling Anthropic directly (uses your Pome API key; no ANTHROPIC_API_KEY needed)",
      false,
    )
    .option(
      "--api-url <url>",
      "Control-plane base URL (only relevant with --hosted).",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .description(
      "Compile prose `## Seed State` sections into sidecar .seed.json files (local: ANTHROPIC_API_KEY; --hosted: routes through Pome cloud)",
    )
    .action(async (target: string | undefined, opts: { force: boolean; hosted: boolean; apiUrl: string }) => {
      const code = await runCompileSeeds(target, {
        force: opts.force,
        hosted: opts.hosted,
        apiBaseUrl: opts.apiUrl,
      });
      if (code !== 0) process.exitCode = code;
    });

  const skills = program
    .command("skills")
    .description(
      "Manage the bundled pome agent skills (/pome-setup, /pome-test)",
    );

  skills
    .command("install")
    .description(
      "Install /pome-setup and /pome-test into ~/.claude/skills/ (symlinked to this pome install by default)",
    )
    .option(
      "--copy",
      "Copy each skill instead of symlinking (CI, Windows without symlink permission)",
      false,
    )
    .option(
      "--force",
      "Overwrite an existing install of the same skill",
      false,
    )
    .option(
      "--dest <dir>",
      "Install into <dir> instead of ~/.claude/skills/ (testing and advanced users)",
    )
    .action(
      async (opts: { copy: boolean; force: boolean; dest?: string }) => {
        await runSkillsInstall({
          copy: opts.copy,
          force: opts.force,
          dest: opts.dest,
        });
      },
    );

  const register = program
    .command("register")
    .description(
      "Register a cloud entity (agent, ...) and link this project to it",
    );

  register
    .command("agent")
    .argument("<name>", "Human-readable agent name (e.g. \"triage-bot\")")
    .option(
      "--api-url <url>",
      "Control-plane URL",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option(
      "--force",
      "Overwrite an existing agentId in pome.config.json",
      false,
    )
    .description(
      "Create a cloud agent under the current team and write agentId to pome.config.json",
    )
    .action(async (name: string, opts: { apiUrl: string; force: boolean }) => {
      try {
        await runRegisterAgent({
          apiBaseUrl: opts.apiUrl,
          name,
          force: opts.force,
        });
      } catch (err) {
        console.error(friendlyHostedError(err));
        process.exitCode = 2;
      }
    });

  const session = program
    .command("session")
    .description(
      "Hosted sandbox sessions (same API as the dashboard Twins page — requires login)",
    );

  session
    .command("create")
    .description("Create a hosted sandbox session for a twin and print its connection info")
    .requiredOption("--twin <name>", "github | stripe")
    .option(
      "--api-url <url>",
      "Control-plane URL",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option("--show-secrets", "Deprecated: secrets are never printed; use --secrets-file", false)
    .option(
      "--secrets-file <path>",
      "Write shell exports containing session secrets to a local file with mode 0600",
    )
    .option(
      "--format <fmt>",
      "text (default) | json | env. env requires --secrets-file and is not printed.",
      "text",
    )
    .action(
      async (opts: {
        twin: string;
        apiUrl: string;
        showSecrets: boolean;
        secretsFile?: string;
        format: string;
      }) => {
        try {
          const format = opts.format.trim().toLowerCase();
          if (!SESSION_CREATE_FORMATS.has(format)) {
            console.error("Unknown session create format. Use one of: text, json, env.");
            process.exitCode = 2;
            return;
          }
          await runSessionCreate({
            apiBaseUrl: opts.apiUrl,
            twin: opts.twin,
            showSecrets: opts.showSecrets,
            format: format as "text" | "json" | "env",
            secretsFile: opts.secretsFile,
          });
        } catch (err) {
          console.error(friendlyHostedError(err));
          process.exitCode = 2;
        }
      },
    );

  session
    .command("list")
    .description("List hosted sessions (defaults to --state running, like the dashboard)")
    .option(
      "--api-url <url>",
      "Control-plane URL",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option("--limit <n>", "Max rows", "20")
    .option(
      "--state <state>",
      "Filter by session state: running (default) | ready | done | expired | all. `running` matches both server-side `ready` and `running` (dashboard collapses both into one column).",
      "running",
    )
    .option("--format <fmt>", "text | json", "text")
    .action(
      async (opts: { apiUrl: string; limit: string; state: string; format: string }) => {
        const validStates: SessionListStateFilter[] = [
          "running",
          "ready",
          "done",
          "expired",
          "all",
        ];
        if (!validStates.includes(opts.state as SessionListStateFilter)) {
          console.error(
            `Unknown --state "${opts.state}". Supported: ${validStates.join(", ")}.`,
          );
          process.exitCode = 2;
          return;
        }
        try {
          await runSessionList({
            apiBaseUrl: opts.apiUrl,
            limit: Number.parseInt(opts.limit, 10) || 20,
            state: opts.state as SessionListStateFilter,
            format: opts.format as "text" | "json",
          });
        } catch (err) {
          console.error(friendlyHostedError(err));
          process.exitCode = 2;
        }
      },
    );

  session
    .command("stop")
    .alias("kill")
    .description("Stop a hosted session (aliased as `kill`)")
    .argument("<session-id>", "Session id (ses_…)")
    .option(
      "--api-url <url>",
      "Control-plane URL",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .action(async (sessionId: string, opts: { apiUrl: string }) => {
      try {
        await runSessionStop({ apiBaseUrl: opts.apiUrl, sessionId });
      } catch (err) {
        console.error(friendlyHostedError(err));
        process.exitCode = 2;
      }
    });

  program
    .command("run")
    .argument("<path>", "Scenario markdown file or directory")
    .option("--agent <command>", "Agent command to run")
    .option("--artifacts-dir <dir>", "Directory for run artifacts", "runs")
    // --hosted is now the default. The flag stays as a one-release no-op so
    // existing scripts and copy-pasted `pome docs` snippets don't break;
    // remove on the next minor bump.
    .option("--hosted", "Deprecated: hosted is now the default. Flag is a no-op.")
    .option(
      "--api-url <url>",
      "Control-plane base URL.",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .option("--agent-model <name>", "Informational; recorded on the cloud run.", "unknown")
    .option(
      "--no-capture",
      "Self-host only: skip spawning the capture-server child and don't inject HTTP_PROXY/HTTPS_PROXY into the agent. Used by the CI overhead gate (FDRS-405) to baseline proxy-on-vs-off latency. No-op on hosted runs.",
    )
    .option(
      "--local",
      "Self-host: run against an in-process twin and CAPTURE a raw trace only (an audit log — no score, no verdict, no judge). A verdict comes from the cloud: run `pome eval <run-dir>` on the captured trace, or `pome login` and run against Pome cloud.",
    )
    .description("Run one or more Pome scenarios")
    .action(
      async (
        target: string,
        options: {
          agent?: string;
          artifactsDir: string;
          hosted: boolean;
          local?: boolean;
          apiUrl: string;
          agentModel: string;
          capture: boolean;
        }
      ) => {
        // F0-5 — `pome run`'s pre-flight (resolving files, reading config,
        // resolving credentials) used to propagate plain `Error`s to
        // Commander's top-level catch, which always demoted to exit 2.
        // That stole exit 3 (auth) from `pome logout && pome run` and
        // exit 5 (usage) from `pome run /does/not/exist.md`. Catch the
        // typed errors (HostedAuthError, HostedQuotaError,
        // HostedUsageError, HostedOrchError) here and map via
        // `exitCodeFor` so the documented contract holds.
        let files: string[];
        let hostedCreds: { apiBaseUrl: string; apiKey: string } | null;
        try {
          files = await scenarioFiles(target);
        } catch (err) {
          const code = exitCodeFor(err);
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = code;
          return;
        }

        const configRead = await readProjectConfig(process.cwd());
        const configCommand = configRead
          ? normalizeConfigAgentCommand(configRead.config)
          : undefined;
        const agentCommand =
          options.agent ?? configCommand ?? DEFAULT_AGENT_COMMAND;
        let worstExit = 0;

        // Hosted is the default. Self-host runs against an in-process twin via
        // `--local` (documented) or POME_LOCAL=1 (an internal escape hatch).
        // FDRS-657: self-host is CAPTURE-ONLY — it records the raw trace and
        // never scores/judges/correlates. A verdict comes only from the cloud
        // (`pome eval <dir>`, or a hosted `pome run`). The --hosted flag is a
        // deprecated no-op kept for one release.
        const useLocal = options.local === true || process.env.POME_LOCAL === "1";
        if (options.hosted && useLocal) {
          console.error(
            "Warning: --hosted is a no-op; running against a local twin (--local / POME_LOCAL=1). Drop it to record runs to the cloud.",
          );
        } else if (options.hosted) {
          console.error("Note: --hosted is now the default; the flag is a deprecated no-op and will be removed in a future release.");
        }
        try {
          hostedCreds = useLocal
            ? null
            : await resolveCredentials({ apiBaseUrl: options.apiUrl });
        } catch (err) {
          const code = exitCodeFor(err);
          console.error(err instanceof Error ? err.message : String(err));
          if (code === 3) {
            console.error(
              "Tip: `pome login` to run against Pome cloud (which returns a verdict), or `pome run --local <path>` to run a self-hosted twin and capture a trace only.",
            );
          }
          process.exitCode = code;
          return;
        }

        for (const file of files) {
          if (hostedCreds) {
            // Hosted path: catch HostedAuthError/QuotaError/OrchError + map to
            // documented exit codes. Anything else falls through to Commander
            // (treated like self-host).
            try {
              const result = await runScenarioHosted({
                scenarioPath: file,
                agentCommand,
                artifactsDir: options.artifactsDir,
                hosted: { baseUrl: hostedCreds.apiBaseUrl, apiKey: hostedCreds.apiKey },
                agentModel: options.agentModel,
              });
              const status = scoreStatus(
                result.score,
                result.scenario.config.passThreshold,
              );
              const label =
                status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "UNEVAL";
              console.error(`${label} ${result.scenario.title}`);
              console.error(`  ${runScoreLine(result.score, result.scenario.config.passThreshold, "cloud score")}`);
              console.error(`  local: ${result.artifacts.runDir}`);
              console.error(`  cloud: ${result.cloudDashboardUrl}`);
              if (result.exitCode !== 0) worstExit = result.exitCode;
            } catch (err) {
              const code = exitCodeFor(err);
              console.error(`ERROR ${file}`);
              console.error(`  ${err instanceof Error ? err.message : String(err)}`);
              if (code > worstExit) worstExit = code;
            }
          } else {
            // Self-host path (FDRS-657): CAPTURE-ONLY. Record the raw trace;
            // no score, no verdict, no judge. Let exceptions (file-not-found,
            // parse errors, agent failures) propagate to Commander's top-level
            // handler.
            const result = await runScenario({
              scenarioPath: file,
              agentCommand,
              artifactsDir: options.artifactsDir,
              // Commander negates --no-* flags: `--no-capture` → `capture: false`.
              noCapture: options.capture === false,
            });
            console.error(`TRACE ${result.scenario.title}`);
            console.error(`  run:  ${result.artifacts.runDir}`);
            console.error(
              `  captured; run \`pome eval ${result.artifacts.runDir}\` for a cloud verdict.`,
            );
            if (result.exitCode !== 0) worstExit = result.exitCode;
          }
        }

        process.exitCode = worstExit;
      }
    );

  program
    .command("eval")
    .argument(
      "[run-dir]",
      "Existing run directory (runs/<scenario>/<run-id>). Omit to use <artifacts-dir>/latest.json.",
    )
    .option(
      "--artifacts-dir <dir>",
      "Directory whose latest.json picks the run when no run dir is given.",
      "runs",
    )
    .option(
      "--agent <slug>",
      "Agent identity for the eval session. Defaults to agentSlug/agentId from pome.config.json.",
    )
    .option(
      "--task <name>",
      "Task name recorded on the eval session. Defaults to meta.json's scenario slug (then title).",
    )
    .option(
      "--api-url <url>",
      "Control-plane base URL.",
      process.env.POME_API_URL ?? DEFAULT_CONTROL_PLANE_URL,
    )
    .description(
      "Upload an existing raw trace directory to Pome cloud for evaluation and print the authoritative score (capture/eval split — no local scoring; requires a control plane with POST /v1/eval-sessions)",
    )
    .action(
      async (
        runDir: string | undefined,
        opts: { artifactsDir: string; agent?: string; task?: string; apiUrl: string },
      ) => {
        await runEvalCommand(runDir, opts);
      },
    );

  // NOTE (FDRS-657): `matrix` / `matrix-html` / `eval-report` were removed.
  // They were a pure LOCAL-scoring orchestrator — they shelled out to
  // `pome run` with POME_LOCAL=1 and aggregated the local score.json each
  // child wrote. With local evaluation gone (the OSS CLI is capture-only),
  // that path cannot produce a verdict, so the whole subsystem was retired
  // rather than left as a broken command. Fleet evaluation lives in the
  // cloud/research workspace.

  program
    .command("inspect")
    .argument("<run>", "Run id, run directory, or latest")
    .option("--artifacts-dir <dir>", "Directory for run artifacts", "runs")
    .description("Print a human-readable run report")
    .action(async (run: string, options: { artifactsDir: string }) => {
      const latest = run === "latest" ? await readLatestRun(options.artifactsDir) : undefined;
      const runDir = latest?.run_dir ?? resolve(run);

      const eventsResult = await readEventsJsonl(runDir);
      if (eventsResult.kind === "legacy") {
        // Exit code 2 is reserved by FDRS-403 for "legacy events.jsonl
        // detected" — distinct from a JSON parse error (which throws and
        // surfaces as exit code 1 via commander's default handling).
        console.error(LEGACY_EVENTS_MESSAGE);
        process.exitCode = 2;
        return;
      }

      const meta = await readMetaSummary(runDir);

      console.log(`Run: ${latest?.run_id ?? run}`);
      console.log(`Directory: ${runDir}`);

      if (eventsResult.kind === "missing") {
        console.log("Events: (events.jsonl not found)");
      } else {
        const health = computeTraceHealth({
          events: eventsResult.events,
          scenarioUsesTwin: meta.twins.length > 0,
        });
        for (const line of renderTraceHealth(health)) console.log(line);
        for (const line of renderEvents(eventsResult.events)) console.log(line);
      }
      // FDRS-657 — `pome inspect` shows ONLY trace/audit content. There is no
      // local verdict: score.json is never written (local artifacts are
      // trace-only). A verdict comes from the cloud — run `pome eval <dir>`
      // (or a hosted `pome run`) and read it on the terminal / dashboard.
    });

  program
    .command("fix-prompt")
    .argument("<events>", "Path to events.jsonl (captured trace)")
    .argument("<scenario>", "Path to scenario.md")
    .description(
      "Assemble a paste-into-IDE fix prompt from the captured trace + the scenario's criteria (no LLM call — paste the output into your own coding assistant)",
    )
    .action(async (eventsPath: string, scenarioPath: string) => {
      const [eventsRaw, scenario] = await Promise.all([
        readFile(resolve(eventsPath), "utf8"),
        parseScenarioFile(resolve(scenarioPath)),
      ]);
      const events: RecorderEvent[] = eventsRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as RecorderEvent);
      // CAPTURE-ONLY (FDRS-657): build the prompt from the raw trace + the
      // scenario's declared criteria. No local judge, no cloud round-trip —
      // the developer's own assistant produces the fix from this prompt.
      console.log(buildFixPrompt({ events, scenario }));
    });

  const twin = program.command("twin").description("Manage local twins");
  twin
    .command("start")
    .argument("<name>", "Twin name")
    .option("--port <port>", "Port to bind", "3333")
    .description("Start a standalone twin")
    .action(async (name: string, options: { port: string }) => {
      if (name !== "github") throw new Error("Only the github twin exists in the MSP.");
      await mkdir(".pome", { recursive: true });
      const db = await openGitHubCloneDatabase(".pome/github.db");
      await seedGitHubCloneDatabase(db);
      const port = Number(options.port);
      const app = (await createGitHubCloneApp({ db, runId: "standalone" })) as any;
      const baseUrl = `http://127.0.0.1:${port}`;
      const restUrl = `${baseUrl}/s/standalone`;
      const mcpUrl = `${restUrl}/mcp`;
      const authSecret = process.env.TWIN_AUTH_SECRET ?? randomBytes(32).toString("hex");
      process.env.TWIN_AUTH_SECRET = authSecret;
      const token = await sign(
        { sid: "standalone", team_id: "tm_local", exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 },
        resolveAuthSecret()
      );
      serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
      await writeFile(
        ".pome/twin-status.json",
        JSON.stringify({ name, url: restUrl, rest_url: restUrl, mcp_url: mcpUrl, auth_token: token }, null, 2)
      );
      console.log(`Pome ${name} twin listening at ${restUrl}`);
      console.log(`POME_GITHUB_REST_URL=${restUrl}`);
      console.log(`POME_GITHUB_MCP_URL=${mcpUrl}`);
      console.log(`POME_AUTH_TOKEN=${token}`);
      // F28 — every `/s/<sid>/*` endpoint requires a Bearer JWT, including
      // /s/standalone/healthz. New users curling the printed `${restUrl}`
      // get HTTP 401 and assume the twin is broken. The unauth liveness
      // probe lives at the root `/healthz`. Print the curl command so
      // copy-paste debugging works without a JWT.
      console.log(`Health check (no auth): curl ${baseUrl}/healthz`);
    });

  twin
    .command("reset")
    .description("Reset standalone twin state")
    .action(async () => {
      await rm(".pome/github.db", { force: true });
      await rm(".pome/github.db-wal", { force: true });
      await rm(".pome/github.db-shm", { force: true });
      await rm(".pome/twin-status.json", { force: true });
      console.log("Standalone GitHub twin state reset.");
    });

  twin
    .command("status")
    .description("Print standalone twin status")
    .action(async () => {
      if (!existsSync(".pome/twin-status.json")) {
        console.log("No standalone twin status found.");
        return;
      }
      console.log(await import("node:fs/promises").then((fs) => fs.readFile(".pome/twin-status.json", "utf8")));
    });

  program
    .command("endpoints")
    .argument("<name>", "Twin name")
    .description("List supported endpoints")
    .action((name: string) => {
      if (name !== "github") throw new Error("Only the github twin exists in the MSP.");
      for (const endpoint of SUPPORTED_GITHUB_ENDPOINTS) {
        console.log(`${endpoint}  semantic`);
      }
    });

  program
    .command("capture-server")
    .description(
      "Boot an HTTP CONNECT-tunnel proxy that appends one LlmCallEvent per tunnel to events.jsonl. Spawned by `pome run`; agent traffic flows via HTTPS_PROXY.",
    )
    .option("--port <port>", "TCP port to listen on (0 = ephemeral).", "8910")
    .option(
      "--events-out <path>",
      "Path to events.jsonl. Created if missing; appended to otherwise.",
    )
    .action(async (opts: { port: string; eventsOut?: string }) => {
      if (!opts.eventsOut) {
        console.error("pome capture-server: --events-out <path> is required");
        process.exitCode = 2;
        return;
      }
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`pome capture-server: invalid --port "${opts.port}"`);
        process.exitCode = 2;
        return;
      }
      const { runCaptureServerCommand } = await import("../capture-server/run.js");
      await runCaptureServerCommand({ port, eventsOut: opts.eventsOut });
    });

  program
    .command("version")
    .description("Print the Pome version")
    .action(() => {
      console.log(PACKAGE_VERSION);
    });

  program
    .command("health")
    .description("Run an in-process smoke check")
    .action(async () => {
      const app = (await createGitHubCloneApp()) as { request: (url: string) => Promise<Response> };
      const response = await app.request("http://pome.local/healthz");
      console.log(await response.text());
    });

  return program;
}

const SUPPORTED_GITHUB_ENDPOINTS = [
  "GET /repos/:owner/:repo",
  "GET /repos/:owner/:repo/issues",
  "GET /repos/:owner/:repo/issues/:number",
  "PATCH /repos/:owner/:repo/issues/:number",
  "POST /repos/:owner/:repo/issues/:number/comments",
  "GET /repos/:owner/:repo/labels",
  "POST /repos/:owner/:repo/labels",
  "GET /repos/:owner/:repo/issues/:number/labels",
  "POST /repos/:owner/:repo/issues/:number/labels",
  "DELETE /repos/:owner/:repo/issues/:number/labels/:name",
  "GET /repos/:owner/:repo/collaborators",
  "POST /repos/:owner/:repo/issues/:number/assignees"
];

async function scenarioFiles(target: string) {
  const resolved = resolve(target);
  // F0-5a — surface bad-input paths as `HostedUsageError` so the top-level
  // exit-code mapper returns the documented exit 5 ("usage error") instead
  // of the default 2 ("twin/orch"). CI consumers branching on $? expect
  // 5 to mean "fix your command", not "retry the cloud".
  if (!existsSync(resolved)) {
    throw new HostedUsageError(`Scenario path not found: ${target}`);
  }
  const stat = await import("node:fs/promises").then((fs) => fs.stat(resolved));
  if (stat.isFile()) return [resolved];
  const entries = await readdir(resolved);
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => join(resolved, entry));
}

async function copyStarterFiles() {
  const packageRoot = resolvePackageRoot(import.meta.url);
  if (!packageRoot) return;

  await Promise.all([
    copyStarterScenarios(packageRoot),
    copyIfPresent(join(packageRoot, "examples", "agents"), join("examples", "agents")),
  ]);
}

async function copyIfPresent(source: string, target: string) {
  if (!existsSync(source)) return;
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

async function copyStarterScenarios(packageRoot: string) {
  const scenarioDir = join(packageRoot, "scenarios");
  if (!existsSync(scenarioDir)) return;

  const starterTwin = findTwin("github");
  const starterScenarios = starterTwin
    ? runnableScenarios(starterTwin).map((s) => s.filename)
    : [];

  await mkdir("scenarios", { recursive: true });
  await Promise.all(
    starterScenarios.flatMap((file) => {
      const sidecar = file.replace(/\.md$/i, ".seed.json");
      return [
        copyIfPresent(join(scenarioDir, file), join("scenarios", file)),
        copyIfPresent(join(scenarioDir, sidecar), join("scenarios", sidecar)),
      ];
    }),
  );
}

// Resolve symlinks on both sides of the entry-point comparison. Without
// this, the guard never matches under a `bun link` / `npm link` install
// where `~/.bun/bin/pome` (or the npm equivalent) is a symlink and
// `process.argv[1]` keeps the symlink path while `import.meta.url`
// resolves to the real file. On macOS the same mismatch hits any `/tmp`
// path because `/tmp` symlinks to `/private/tmp`. Symptom: invoking
// `pome` (the symlinked binary) prints nothing and exits 0.
function isMainEntry(): boolean {
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return here === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (err) {
    console.error(
      err instanceof Error ? err.message : "Error: unexpected failure",
    );
    process.exitCode = 2;
  }
}
