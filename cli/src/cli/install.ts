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
// red after the session → named cause + fix, exit 1. The terminal-rendered
// file-list + diff + [y/N] gate from moment 02 is deferred to FDRS-661; the
// pome-setup skill written for this cut is the knowledge layer both reuse.

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { HostedAuthError } from "../hosted/errors.js";
import { resolveCredentials } from "./credentials.js";
import { loginWithClerk, type LoginOptions } from "./login.js";
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
    // FDRS-669 — a previously-inited repo still gets its agent registered on
    // the fallback path; a truly fresh repo has no config yet (the manual
    // steps below start with `pome init`), so this is a silent no-op there.
    await registerAgentStep({
      apiBaseUrl: options.apiUrl,
      cwd,
      credentialsPath: options.credentialsPath,
    });
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

  // 4. Ensure the pome-setup skill is where the agent looks for it
  // (~/.claude/skills/, symlinked to this install; skips if present).
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

  // 5. Hand off. stdio inherit = the user drives the agent in this terminal;
  // the diff gate is the agent's own edit-approval UI (deliberately no
  // --permission-mode override).
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

  // 6. FDRS-669 — register the agent (idempotent) now that the session has
  // had its chance to create pome.config.json. Runs before the doctor verify
  // so even a red-doctor install leaves the repo registered: the first bare
  // `pome run` submits under this agent, and "Default agent" stays a
  // migration-era state only (Reliability IA v1, decision 2).
  console.error("");
  await registerAgentStep({
    apiBaseUrl: options.apiUrl,
    cwd,
    credentialsPath: options.credentialsPath,
  });

  // 7. The ending pome's terminal owns: doctor verify to green (moment 02).
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

/** FDRS-669 — the install-time registration bracket. Registration failing
 *  must not fail the install (runs would just land under "Default agent"
 *  until the user re-runs install or `pome register agent`), so every
 *  outcome renders as a line, never an exit code. */
async function registerAgentStep(input: {
  apiBaseUrl: string;
  cwd: string;
  credentialsPath?: string;
}): Promise<void> {
  const { ensureAgentRegistered } = await import("./register.js");
  try {
    const result = await ensureAgentRegistered(input);
    if (result.status === "registered") {
      console.error(
        `✓ registered agent (slug=${result.agentSlug}) — runs submit under it.`,
      );
    } else if (result.status === "already-registered") {
      console.error(
        `✓ agent already registered (${result.agentSlug ?? result.agentId}).`,
      );
    }
    // no-config: silent — the session/manual steps own creating the config;
    // registration happens on the next `pome install` once it exists.
  } catch (err) {
    console.error(
      `couldn't register the agent: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "runs will record under \"Default agent\" until `pome register agent <name>` or a re-run of pome install succeeds.",
    );
  }
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
