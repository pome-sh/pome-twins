// SPDX-License-Identifier: Apache-2.0
// FDRS-642 — `pome install`: agent-driven wiring with the diff gate in the
// coding agent's own edit-approval UI.
//
// v1 is skills-first thin orchestration (see the ticket's [DECISION]): the
// wiring brain is the user's own coding agent, invoked interactively — not
// an embedded SDK, not a pome-hosted LLM gateway. The CLI's job is the
// bracket around that session:
//
//   auth check → detect agent → git-as-undo guard → ensure the pome-setup
//   skill → interactive session (the user approves edits in the agent's own
//   UI) → doctor verify to green (CLI moments 02, "verifying the wiring").
//
// No coding agent on PATH → print manual wiring steps + a paste-into-any-
// agent prompt and exit 0 (the designed fallback, not a failure). Doctor
// red after the session → named cause + fix, exit 1.
//
// FDRS-661 layers the terminal diff gate from moment 02 on top: when the
// machine has Claude credentials, the default flow embeds the agent
// HEADLESS (Claude Agent SDK driver on the user's own credentials + the
// user's own `claude` binary), stages its edits in a shadow copy, and
// renders the file list + unified diff in pome's terminal — the working
// tree changes only on [y]. The interactive handoff above survives as the
// fallback (no credentials, declined SDK download, or --interactive).

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { HostedAuthError } from "../hosted/errors.js";
import {
  agentSdkDir,
  detectClaudeLogin,
  isAgentSdkProvisioned,
  loadAgentSdk,
  provisionAgentSdk,
  type AgentSdkModule,
} from "./agent-sdk.js";
import { resolveCredentials } from "./credentials.js";
import { runEmbeddedWiring } from "./embedded-wiring.js";
import { loginWithClerk, type LoginOptions } from "./login.js";
import { resolvePackageRoot } from "./resolve-package-root.js";
import { runSkillsInstall } from "./skills.js";

const execFileAsync = promisify(execFile);

/** Coding agents `pome install` can hand off to, in detection order. */
const KNOWN_AGENTS = [{ bin: "claude", label: "Claude Code" }] as const;

/** First message of the interactive session. The skill carries the wiring
 *  knowledge; this only names it, sets adapter-first, and fixes the exit
 *  contract (pome verifies with doctor after the session ends). */
export const KICKOFF_PROMPT =
  "Use the pome-setup skill to wire this repository to pome (adapter-first: " +
  "withPome() + env-injected base URL). Follow the skill's steps and show me " +
  "each edit for approval before applying. When the wiring is done, exit " +
  "this session — pome will verify it with `pome doctor`.";

/** Self-contained fallback prompt for users without a detected coding agent
 *  (their agent won't have the pome-setup skill installed). */
export const PASTE_PROMPT = [
  "Wire this repository to pome (https://pome.sh) so its agent runs against a twin in test:",
  "1. If pome.config.json is missing, run `pome init`; set agent.command to how this agent starts.",
  "2. Claude Agent SDK repos: add @pome-sh/adapter-claude-sdk, import query/tool from it (drop-in replacements), and call withPome() once at startup.",
  "3. Replace every hardcoded production API host (e.g. https://api.github.com) with the env the pome runner injects: read POME_GITHUB_REST_URL / POME_GITHUB_MCP_URL and POME_AUTH_TOKEN from process.env. Never write secrets or URLs into source.",
  "4. Make minimal, targeted edits and show each diff for approval before applying.",
  "5. Finish by running `pome doctor` and fixing its named cause until it exits green.",
].join("\n");

export interface InstallOptions {
  apiUrl: string;
  dashboardUrl: string;
  /** Force the interactive agent-session handoff (skip the headless
   *  staged-diff flow). */
  interactive?: boolean;
  /** Repo root the session wires. Defaults to process.cwd(). */
  cwd?: string;
  /** Test seam — forwarded to resolveCredentials. */
  credentialsPath?: string;
  /** Test seam — defaults to process.stdin.isTTY. */
  stdinIsTTY?: boolean;
  /** Test seam — defaults to a readline [y/N] prompt on stderr. */
  confirm?: (question: string) => Promise<boolean>;
  /** Test seam — defaults to loginWithClerk (opens a browser). */
  login?: (options: LoginOptions) => Promise<void>;
  /** Test seam — defaults to detectClaudeLogin (keychain/credentials/env). */
  hasClaudeLogin?: () => boolean;
  /** Test seam — defaults to the consent-gated provision + import of the
   *  Claude Agent SDK driver. */
  acquireSdk?: (
    confirm: (question: string) => Promise<boolean>,
  ) => Promise<AgentSdkModule | null>;
}

export async function runInstall(options: InstallOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const confirm = options.confirm ?? promptYesNo;
  const login = options.login ?? loginWithClerk;

  // Interactive by design: the whole point is handing THIS terminal to an
  // agent session the user supervises. A pipe can't approve edits.
  if (!stdinIsTTY) {
    console.error(
      "pome install is interactive — it hands your terminal to a coding agent session.",
    );
    console.error(
      "Run it from a terminal. For unattended setups, wire manually: see `pome docs`.",
    );
    process.exitCode = 2;
    return;
  }

  console.error("pome will wire your agent to a twin in test.");
  console.error("");

  // 1. Auth first — auth happens at this journey stage (Done-when bullet 1).
  // Logging in here means neither the agent session nor anything after it
  // trips over missing credentials.
  try {
    await resolveCredentials({
      apiBaseUrl: options.apiUrl,
      credentialsPath: options.credentialsPath,
    });
    console.error("✓ signed in");
  } catch (err) {
    if (!(err instanceof HostedAuthError)) throw err;
    console.error("no pome credentials found — routing through pome login first.");
    await login({
      apiUrl: options.apiUrl,
      dashboardUrl: options.dashboardUrl,
      keyName: "pome install",
    });
  }

  // 2. Detect the coding agent before the git guard: the fallback path edits
  // nothing, so an unclean tree shouldn't block it.
  const agent = detectAgent(process.env);
  if (!agent) {
    printManualFallback();
    return; // exit 0 — the designed no-agent outcome, not a failure.
  }

  // 3. Git-as-undo guard. The session edits files and git is the only
  // rollback — make that precondition explicit instead of assuming it.
  const tree = await inspectWorkingTree(cwd);
  if (tree === "dirty") {
    console.error("");
    console.error(
      "this repo has uncommitted changes. the agent session edits files, and its",
    );
    console.error(
      "edits will mix with yours — git is the only undo for an agent mis-edit.",
    );
    if (!(await confirm("continue anyway? (commit or stash first is safer) [y/N] "))) {
      console.error("aborted — nothing changed. commit or stash, then re-run pome install.");
      return;
    }
  } else if (tree === "not-a-repo") {
    console.error("");
    console.error(
      "this directory is not a git repository — if the agent session mis-edits a",
    );
    console.error("file, there is NO undo.");
    if (!(await confirm("continue without version control? [y/N] "))) {
      console.error(
        "aborted — nothing changed. git init && git add -A && git commit, then re-run.",
      );
      return;
    }
  }

  // 4. The default path: embed the agent headless and gate its edits behind
  // pome's own terminal diff (moment 02). Falls back to the interactive
  // handoff when the pieces aren't there or the user asked for it.
  let stagedApplied = false;
  if (!options.interactive) {
    const hasLogin = options.hasClaudeLogin ?? (() => detectClaudeLogin());
    if (!hasLogin()) {
      console.error("");
      console.error(
        "no Claude login or ANTHROPIC_API_KEY found for the headless staged-diff flow —",
      );
      console.error("handing off to an interactive session instead.");
    } else {
      const skillSourceDir = packagedSkillDir();
      const acquireSdk = options.acquireSdk ?? acquireAgentSdkWithConsent;
      const sdk = skillSourceDir ? await acquireSdk(confirm) : null;
      if (!skillSourceDir) {
        console.error("");
        console.error(
          "bundled pome-setup skill missing from this install — using the interactive session.",
        );
      } else if (!sdk) {
        console.error("continuing with the interactive session instead.");
      } else {
        console.error("");
        console.error(
          `wiring with ${agent.label} (headless) — nothing is written until you approve the diff.`,
        );
        const outcome = await runEmbeddedWiring({
          cwd,
          claudePath: agent.path,
          skillSourceDir,
          query: sdk.query,
          confirm,
        });
        if (outcome.kind === "declined") {
          console.error(
            "aborted — nothing changed. re-run pome install to try again, or",
          );
          console.error("`pome install --interactive` to drive the session yourself.");
          return;
        }
        if (outcome.kind === "no-diff") {
          // Never a silent no-op: name the reason the session produced no
          // applicable diff (Done-when bullet 2).
          console.error("");
          console.error("the session staged no changes — nothing to apply.");
          console.error(`reason: ${outcome.reason}`);
          console.error(
            "re-run pome install, or `pome install --interactive` to drive the session yourself.",
          );
          process.exitCode = 1;
          return;
        }
        if (outcome.kind === "session-error") {
          console.error("");
          console.error(outcome.reason);
          console.error(
            "re-run pome install, or `pome install --interactive` to drive the session yourself.",
          );
          process.exitCode = 1;
          return;
        }
        // applied — the session never runs installs itself (no Bash in the
        // staging tool set); dependencies it added land here, before doctor.
        if (outcome.packageJsonChanged) {
          await runPackageInstall(cwd);
        }
        stagedApplied = true;
      }
    }
  }

  if (!stagedApplied) {
    // 4b. Interactive fallback — the FDRS-642 flow, unchanged: ensure the
    // pome-setup skill where the agent looks for it (~/.claude/skills/),
    // then hand this terminal to the agent; the diff gate is the agent's
    // own edit-approval UI.
    console.error("");
    await runSkillsInstall({});
    if (process.exitCode === 2) {
      // runSkillsInstall signals failure (no ~/.claude, packaging problem) via
      // exitCode — the session would run without the skill, so hand the user
      // the manual path instead. Keep exit 2: unlike the no-agent fallback,
      // this is a real environment problem.
      console.error("");
      console.error("couldn't install the pome-setup skill — falling back to manual steps.");
      printManualFallback();
      return;
    }

    console.error("");
    console.error(
      `handing off to ${agent.label} — review and approve its edits in the session.`,
    );
    console.error("exit the session when the wiring is done; pome verifies it after.");
    console.error("");
    const sessionExit = await runAgentSession(agent.path, [KICKOFF_PROMPT], cwd);
    if (sessionExit !== 0) {
      console.error(
        `(${agent.label} exited ${sessionExit} — verifying anyway; doctor is the source of truth.)`,
      );
    }
  }

  // 6. The ending pome's terminal owns: doctor verify to green (moment 02).
  // Dynamic import keeps the twin harness out of the way until needed —
  // same pattern as the `doctor` and `run` commands.
  console.error("");
  const { runDoctorChecks } = await import("../doctor/checks.js");
  const { renderDoctorReport } = await import("../doctor/render.js");
  const report = await runDoctorChecks({ mode: "full", cwd });
  for (const line of renderDoctorReport(report, { header: "verifying the wiring …" })) {
    console.error(line);
  }
  console.error("");
  if (report.ok) {
    console.error("wiring verified — your agent is ready.");
    console.error("");
    console.error(
      "next: pome scenarios github --copy      # pull runnable scenarios into ./scenarios/",
    );
    console.error("      pome run scenarios/01-bug-happy-path.md");
    return;
  }
  console.error(
    "the agent session ended but the wiring isn't green — fix the cause above,",
  );
  console.error("or re-run pome install to hand the fix back to your agent.");
  process.exitCode = 1;
}

export interface DetectedAgent {
  bin: string;
  label: string;
  path: string;
}

/** First known coding agent found on PATH, or null. Exported for tests. */
export function detectAgent(
  env: Record<string, string | undefined> = process.env,
): DetectedAgent | null {
  for (const agent of KNOWN_AGENTS) {
    const found = findExecutableOnPath(agent.bin, env);
    if (found) return { ...agent, path: found };
  }
  return null;
}

function findExecutableOnPath(
  bin: string,
  env: Record<string, string | undefined>,
): string | null {
  const names =
    process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

type WorkingTree = "clean" | "dirty" | "not-a-repo";

async function inspectWorkingTree(cwd: string): Promise<WorkingTree> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
    });
    return stdout.trim().length === 0 ? "clean" : "dirty";
  } catch {
    // Not a git repo, or no git binary — either way there is no undo.
    return "not-a-repo";
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(question, resolve),
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function runAgentSession(
  command: string,
  args: string[],
  cwd: string,
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      resolvePromise(code ?? (signal ? 1 : 0));
    });
  });
}

/** The bundled pome-setup skill inside this pome install — the knowledge
 *  layer the embedded session loads from the shadow's .claude/skills. */
function packagedSkillDir(): string | null {
  const root = resolvePackageRoot(import.meta.url);
  if (!root) return null;
  const dir = join(root, "skills", "pome-setup");
  return existsSync(dir) ? dir : null;
}

/** Consent-gated one-time download of the Claude Agent SDK driver into
 *  ~/.pome/agent-sdk (a few MB — the ~244 MB platform runtime is skipped;
 *  the session runs on the user's own `claude` binary). */
async function acquireAgentSdkWithConsent(
  confirm: (question: string) => Promise<boolean>,
): Promise<AgentSdkModule | null> {
  const dir = agentSdkDir();
  if (!isAgentSdkProvisioned(dir)) {
    console.error("");
    console.error("pome can run the wiring headless and show you one reviewable diff before");
    console.error("anything is written. this needs a one-time download of the Claude Agent");
    console.error(`SDK driver (a few MB) into ${dir}.`);
    if (!(await confirm("download it now? [y/N] "))) return null;
    if (!(await provisionAgentSdk(dir))) return null;
  }
  const sdk = await loadAgentSdk(dir);
  if (!sdk) console.error("couldn't load the Claude Agent SDK driver.");
  return sdk;
}

/** The package manager a lockfile in `dir` names, or null. Exported for tests. */
export function lockfilePackageManager(dir: string): "bun" | "pnpm" | "yarn" | "npm" | null {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return null;
}

/** Install dependencies the staged diff added to package.json, with the
 *  repo's own package manager. The lockfile names it — checked in `cwd`
 *  first, then up the ancestor chain, because in a workspace the lockfile
 *  lives at the workspace root, not the package being wired. The install
 *  itself still runs in `cwd`; every manager resolves its own workspace
 *  root upward from there. */
async function runPackageInstall(cwd: string): Promise<void> {
  let pm: "bun" | "pnpm" | "yarn" | "npm" | null = null;
  for (let dir = cwd; ; ) {
    pm = lockfilePackageManager(dir);
    if (pm) break;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  pm ??= "npm";
  console.error("");
  console.error(`package.json changed — running ${pm} install …`);
  const exit = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(pm, ["install"], { cwd, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  }).catch(() => 1);
  if (exit !== 0) {
    console.error(`(${pm} install exited ${exit} — doctor will name what's missing.)`);
  }
}

function printManualFallback(): void {
  console.error(
    `no coding agent found on PATH (looked for: ${KNOWN_AGENTS.map((a) => a.bin).join(", ")}).`,
  );
  console.error("");
  console.error("wire it manually:");
  console.error("  1. config       pome init                  # if pome.config.json is missing;");
  console.error("                                              # then set agent.command to your agent's start command");
  console.error("  2. adapter      npm install @pome-sh/adapter-claude-sdk");
  console.error('  3. hook + env   import { withPome } from "@pome-sh/adapter-claude-sdk"; withPome();');
  console.error("                  read the twin URL from env, never hardcode:");
  console.error("                  const { POME_GITHUB_REST_URL: baseUrl, POME_AUTH_TOKEN: token } = process.env;");
  console.error("  4. verify       pome doctor                # must end green");
  console.error("");
  console.error("or paste this into any coding agent:");
  console.error("─".repeat(72));
  console.error(PASTE_PROMPT);
  console.error("─".repeat(72));
}
