#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { serve } from "@hono/node-server";
import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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
import { effectiveTrialCount, parseTrialsFlag } from "../runner/trialCount.js";
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
  copyAnnounceLine,
  ensureDefaultTask,
  runYoursFrameLines,
  trialsPinFallbackLine,
  type DefaultTaskResolution,
} from "./default-task.js";
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
import { resolveAuthSecret } from "@pome-sh/twin-github";
import {
  buildFixPrompt,
  buildGroupFixPrompt,
  type TrialFixInput,
} from "../fix-prompt/index.js";
import {
  discoverRunSet,
  loadTrialEvents,
} from "../recorder/verdictArtifact.js";
import type { Scenario } from "../scenario/scenarioSchema.js";
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
    .command("install")
    .description(
      "Wire this repo to pome with your own coding agent: checks auth (routes through pome login when needed), hands off to an interactive agent session — you approve its edits in the agent's own UI — then verifies with pome doctor. No coding agent on PATH → prints manual wiring steps + a paste-into-any-agent prompt.",
    )
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
    .action(async (opts: { apiUrl: string; dashboardUrl: string }) => {
      // Dynamic import mirrors the doctor/run commands: keep install's
      // dependency graph out of every other command's startup path.
      const { runInstall } = await import("./install.js");
      await runInstall({ apiUrl: opts.apiUrl, dashboardUrl: opts.dashboardUrl });
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
    .argument(
      "[path]",
      'Task markdown file or directory. Omit to run the demo task ("that was ours, run yours"): scenarios/first-run-demo.md is dropped into your project on first use with runs: 5 pinned.',
    )
    .option("--agent <command>", "Agent command to run")
    .option(
      "-n, --trials <count>",
      "FDRS-636: run <count> isolated trials of the task as ONE trial group (integer 1-20; hosted only). " +
        "Default is the scenario config's `runs` field (capped at 20). k>1 mints all sessions upfront with a shared group id, " +
        "runs trials sequentially, prints the per-trial verdict table (numeric cloud-judge scores), and exits 0 iff at least one " +
        "trial completed and every completed trial passed (1: a completed trial failed; 2: nothing completed). " +
        "k=1 keeps today's single-run behavior exactly.",
    )
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
    .description(
      'Run one or more Pome tasks. With no path, runs the demo task (scenarios/first-run-demo.md, copied into your project on first use — "that was ours, run yours"). Refuses to start if the doctor wiring checks fail (see `pome doctor`); there is no --force.',
    )
    .action(
      async (
        target: string | undefined,
        options: {
          agent?: string;
          trials?: string;
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

        // FDRS-636 — validate -n before anything runs (documented exit 5 on
        // a bad value, same as any other usage error).
        let trialsFlag: number | undefined;
        if (options.trials !== undefined) {
          try {
            trialsFlag = parseTrialsFlag(options.trials);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = exitCodeFor(err);
            return;
          }
        }

        // FDRS-645 — "run yours": bare `pome run` defaults to the demo task
        // via a user-visible copy (scenarios/first-run-demo.md, dropped on
        // first use; its Config pins runs: 5 so an explicit -n still wins).
        // The moment-05 frame prints later, once the doctor + credential
        // gates have passed.
        let defaultTask: DefaultTaskResolution | null = null;
        if (target === undefined) {
          try {
            defaultTask = await ensureDefaultTask();
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = exitCodeFor(err);
            return;
          }
          if (defaultTask.copied) console.error(copyAnnounceLine(defaultTask));
          if (!defaultTask.trialsApplied) console.error(trialsPinFallbackLine());
          target = defaultTask.path;
        }

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

        // FDRS-636 — trial groups are a hosted feature: the verdicts come
        // from cloud evaluation, and self-host runs are capture-only. Reject
        // the combination loudly instead of silently ignoring the flag.
        if (trialsFlag !== undefined && useLocal) {
          console.error(
            "-n/--trials needs the hosted path (verdicts come from the cloud judge); --local runs capture a single trace. Drop --local or -n.",
          );
          process.exitCode = 5;
          return;
        }

        // FDRS-641 — doctor preflight gate. A repo failing any applicable
        // doctor check refuses to spawn the agent — BEFORE credentials are
        // resolved and before any twin/session is provisioned. Local runs get
        // the full engine (incl. local twin boot); hosted runs skip the local
        // twin (the cloud provisions the session twin) but still gate on
        // config, routing, and the egress floor. Deliberately no --force /
        // --skip-checks escape: "never a false success" — pome will not run
        // trials against a live API. (Design: CLI moments 03; engine:
        // FDRS-634.)
        {
          const { runDoctorChecks } = await import("../doctor/checks.js");
          const { renderDoctorReport } = await import("../doctor/render.js");
          const doctorReport = await runDoctorChecks({ mode: useLocal ? "full" : "hosted" });
          if (!doctorReport.ok) {
            for (const line of renderDoctorReport(doctorReport)) console.error(line);
            console.error("");
            console.error(
              "pome run: wiring check failed — refusing to spawn the agent. Fix the cause above and re-run (there is no --force).",
            );
            process.exitCode = 1;
            return;
          }
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

        // FDRS-645 — the moment-05 frame, only for the bare-run default and
        // only once every gate that could refuse the run has passed.
        if (defaultTask) {
          for (const line of runYoursFrameLines()) console.error(line);
        }

        for (const file of files) {
          if (hostedCreds) {
            // Hosted path: catch HostedAuthError/QuotaError/OrchError + map to
            // documented exit codes. Anything else falls through to Commander
            // (treated like self-host).
            try {
              // FDRS-636 — effective trial count: -n wins, else the scenario
              // config's `runs` field (both capped at 20). k>1 takes the
              // trial-group path; k=1 stays EXACTLY the single-run path
              // below (no group is ever stamped for it).
              const scenarioForRuns = await parseScenarioFile(file);
              const k = effectiveTrialCount(
                trialsFlag,
                scenarioForRuns.config.runs,
              );
              if (k > 1) {
                const { runTrialGroup } = await import(
                  "../runner/runTrialGroup.js"
                );
                // FDRS-644 — the literal re-run command the fix handoff
                // prints: bare default-task runs re-run as bare `pome run`;
                // explicit paths re-run by (cwd-relative) path + -n.
                const fileForRerun = relative(process.cwd(), file);
                const rerunCommand = defaultTask
                  ? options.trials !== undefined
                    ? `pome run -n ${k}`
                    : "pome run"
                  : `pome run ${
                      fileForRerun && !fileForRerun.startsWith("..")
                        ? fileForRerun
                        : file
                    } -n ${k}`;
                const groupResult = await runTrialGroup({
                  scenarioPath: file,
                  agentCommand,
                  agentCommandSource: options.agent
                    ? "--agent"
                    : configCommand
                      ? "pome.config.json"
                      : "built-in default",
                  trials: k,
                  artifactsDir: options.artifactsDir,
                  hosted: {
                    baseUrl: hostedCreds.apiBaseUrl,
                    apiKey: hostedCreds.apiKey,
                  },
                  dashboardBaseUrl:
                    process.env.POME_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
                  agentModel: options.agentModel,
                  rerunCommand,
                });
                if (groupResult.exitCode > worstExit) {
                  worstExit = groupResult.exitCode;
                }
                continue;
              }

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
            // FDRS-635 — name every host the egress floor refused, so a stray
            // production call is a visible event, never a silent passthrough.
            if (result.blockedEgress.length > 0) {
              const refusals = result.blockedEgress.reduce((n, b) => n + b.count, 0);
              const named = result.blockedEgress
                .map((b) => `${b.host}:${b.port}${b.count > 1 ? ` ×${b.count}` : ""}`)
                .join(", ");
              console.error(
                `  egress: refused ${refusals} tunnel(s) to non-allowlisted host(s) — ${named}`,
              );
              console.error(
                "          twin + LLM traffic is unaffected; extend with POME_EGRESS_ALLOW=<host,…> if intentional.",
              );
            }
            if (result.exitCode !== 0) worstExit = result.exitCode;
          }
        }

        process.exitCode = worstExit;
      }
    );

  program
    .command("demo")
    .description(
      "Zero-auth first-run demo: boots a local GitHub twin, runs the bundled demo agent for 5 isolated trials (model calls via pome's anonymous demo gateway), and prints per-trial verdicts evaluated in Pome cloud. No signup, no API keys; ends with a no-login preview link.",
    )
    .option(
      "--api-url <url>",
      "Control-plane base URL.",
      process.env.POME_API_BASE ??
        process.env.POME_API_URL ??
        DEFAULT_CONTROL_PLANE_URL,
    )
    .option(
      "--trials <n>",
      "Number of isolated trials (default 5 per the packaged demo).",
      "5",
    )
    .option("--artifacts-dir <dir>", "Directory for run artifacts", "runs")
    .action(
      async (opts: { apiUrl: string; trials: string; artifactsDir: string }) => {
        const trials = Number.parseInt(opts.trials, 10);
        if (!Number.isInteger(trials) || trials < 1 || trials > 10) {
          console.error(`Invalid --trials "${opts.trials}" (expected 1-10).`);
          process.exitCode = 5;
          return;
        }
        // Dynamic import mirrors doctor/install: keep the demo dependency
        // graph out of every other command's startup path.
        const { runDemo } = await import("../demo/runDemo.js");
        const result = await runDemo({
          apiBase: opts.apiUrl.replace(/\/$/, ""),
          dashboardBase:
            process.env.POME_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
          trials,
          artifactsDir: opts.artifactsDir,
        });
        process.exitCode = result.exitCode;
      },
    );

  // Hidden: the bundled demo agent `pome demo` spawns as its trial child
  // through the real capture path (FDRS-643). Reads the POME_* env contract
  // injected by runScenario plus POME_DEMO_* gateway coordinates.
  program
    .command("demo-agent", { hidden: true })
    .description("Internal: the bundled demo agent process (spawned by `pome demo`).")
    .action(async () => {
      const { runDemoAgentCommand } = await import("../demo/agent.js");
      const code = await runDemoAgentCommand();
      if (code !== 0) process.exitCode = code;
    });

  program
    .command("doctor")
    .description(
      "Check the agent↔twin wiring: pome.config.json present + valid, twin reachable, requests routed to the twin (not a hardcoded production host), egress floor active. On failure prints one named cause (file:line where knowable) + one concrete fix and exits non-zero.",
    )
    .action(async () => {
      const { runDoctorChecks } = await import("../doctor/checks.js");
      const { renderDoctorReport } = await import("../doctor/render.js");
      const report = await runDoctorChecks();
      for (const line of renderDoctorReport(report)) console.error(line);
      if (!report.ok) process.exitCode = 1;
    });

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
    .argument(
      "[target]",
      "Artifacts root or a trial run dir (default: runs). Legacy form: a path to events.jsonl — then <scenario> is required.",
    )
    .argument(
      "[scenario]",
      "Path to scenario.md (only with an events.jsonl target)",
    )
    .description(
      "Assemble a paste-into-IDE fix prompt (no LLM call, no network). With no args, reads the latest FAILED run set under ./runs: the persisted cloud verdicts (verdict.json) become grouped failure signatures over the raw traces, in one prompt. Point it at a trial run dir to target that set, or use the legacy `<events.jsonl> <scenario.md>` form for a single trace.",
    )
    .action(async (target?: string, scenarioArg?: string) => {
      // Legacy 2-arg form: <events.jsonl> <scenario.md> — unchanged
      // (CAPTURE-ONLY, FDRS-657: raw trace + declared criteria, no verdict).
      if (target !== undefined && target.endsWith(".jsonl")) {
        if (!scenarioArg) {
          console.error(
            "The events.jsonl form needs the scenario: pome fix-prompt <events.jsonl> <scenario.md>",
          );
          process.exitCode = 5;
          return;
        }
        const [eventsRaw, scenario] = await Promise.all([
          readFile(resolve(target), "utf8"),
          parseScenarioFile(resolve(scenarioArg)),
        ]);
        const events: RecorderEvent[] = eventsRaw
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as RecorderEvent);
        console.log(buildFixPrompt({ events, scenario }));
        return;
      }
      if (scenarioArg !== undefined) {
        console.error(
          "The second argument only applies to the events.jsonl form: pome fix-prompt <events.jsonl> <scenario.md>",
        );
        process.exitCode = 5;
        return;
      }

      // FDRS-644 — run-set mode. Reassemble the run set from persisted
      // CLOUD verdicts (verdict.json, written by hosted `pome run`) + raw
      // traces, and emit ONE prompt with grouped failure signatures. Still
      // no network and no local judging — the verdicts were the cloud's.
      const root = target ?? "runs";
      const discovery = await discoverRunSet(resolve(root));
      if (discovery.totalSets === 0) {
        console.error(
          `No finalized run sets under ${root} — hosted \`pome run\` records a verdict.json per trial; run one first (or point fix-prompt at your artifacts dir).`,
        );
        process.exitCode = 5;
        return;
      }
      if (!discovery.set) {
        console.error(
          `Nothing to fix: the latest run sets under ${root} all passed.`,
        );
        return;
      }
      const set = discovery.set;
      let scenario: Scenario | null = null;
      try {
        scenario = await parseScenarioFile(resolve(set.scenarioPath));
      } catch {
        // Task file moved/edited since the run — the prompt degrades to the
        // verdict-embedded criteria.
        scenario = null;
      }
      const trials: TrialFixInput[] = [];
      for (const [idx, t] of set.trials.entries()) {
        trials.push({
          label: `trial ${idx + 1} · ${t.verdict.session_id}`,
          runDir: t.runDir,
          verdict: t.verdict,
          events: (await loadTrialEvents(t.runDir)) as RecorderEvent[],
        });
      }
      console.log(
        buildGroupFixPrompt({
          taskName: set.taskName,
          groupId: set.groupId,
          scenario,
          trials,
        }),
      );
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
    .option(
      "--allow <hosts>",
      "FDRS-635: comma-separated egress allowlist patterns (exact host or *.suffix). The floor is deny-by-default: only these hosts + loopback are tunnelled; everything else gets 403.",
    )
    .option(
      "--egress-out <path>",
      "Path to egress.jsonl, the sidecar recording refused CONNECTs. Optional; the floor enforces regardless.",
    )
    .action(async (opts: { port: string; eventsOut?: string; allow?: string; egressOut?: string }) => {
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
      const { parseAllowCsv } = await import("../capture-server/egress.js");
      await runCaptureServerCommand({
        port,
        eventsOut: opts.eventsOut,
        allowHosts: parseAllowCsv(opts.allow),
        egressOut: opts.egressOut,
      });
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
