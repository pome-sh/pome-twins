// SPDX-License-Identifier: Apache-2.0
// FDRS-661 — the terminal diff gate: run the wiring agent headless in a
// SHADOW copy of the repo, collect its edits as one git diff, render the
// moment-02 file list + unified diff in pome's own terminal, and touch the
// real working tree only after an explicit [y].
//
// Why a shadow workspace instead of canUseTool-deny-and-record: a denied
// Edit looks like a failure to the agent, which then retries; letting the
// edits land in an isolated copy keeps the session self-consistent (its
// Reads see its own writes) and the diff comes from git afterwards, exact
// and binary-safe. canUseTool still runs on every call — it confines all
// file paths to the shadow root (a live probe caught the model reaching
// for $HOME on turn one) and refuses tools outside the whitelist.
//
// The user's `.claude/` is deliberately NOT copied into the shadow:
// settings-file allow rules would shadow the canUseTool gate (the SDK
// warns about exactly this), and the only skill the session needs is the
// pome-setup skill pome injects itself.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { AgentSdkQueryFn } from "./agent-sdk.js";

const execFileAsync = promisify(execFile);

/** Tools the staging session may use. Everything else — Bash above all —
 *  is refused: package installs and verification are pome's job, after
 *  the diff is approved. NOTE: never mirror these into `allowedTools`;
 *  bare allowedTools entries auto-approve before canUseTool is consulted. */
export const STAGING_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"] as const;

/** First message of the headless session. The pome-setup skill (injected
 *  into the shadow's .claude/skills) carries the wiring knowledge; this
 *  adapts its interactive contract to staging: edits land automatically,
 *  the human approves ONE combined diff in pome's terminal afterwards. */
export const EMBEDDED_KICKOFF_PROMPT = [
  "Use the pome-setup skill to wire this repository to pome (adapter-first:",
  "withPome() + env-injected base URL). You are running non-interactively",
  "inside a staged copy of the repo:",
  "- There is no user to ask questions mid-session. Where the skill says to",
  "  pause and confirm, proceed with the best-evidence interpretation and",
  "  note the assumption in your final summary.",
  "- Your edits are staged automatically; pome renders the combined diff for",
  "  the user's approval after this session. That is the skill's diff-approval",
  "  gate — do not wait for per-edit approval.",
  "- Do not run package installs or shell commands: add dependencies by",
  "  editing package.json only. pome runs the install after the diff is",
  "  applied.",
  "- Do not run pome doctor — pome verifies the wiring itself after applying.",
  "When the wiring edits are complete, end the session with a one-line",
  "summary. If you cannot produce the wiring, make no edits and end with a",
  "short explanation of why.",
].join("\n");

export type EmbeddedWiringOutcome =
  | { kind: "applied"; files: number; packageJsonChanged: boolean }
  | { kind: "declined" }
  | { kind: "no-diff"; reason: string }
  | { kind: "session-error"; reason: string };

export interface EmbeddedWiringOptions {
  /** The real repo root the approved diff is applied to. */
  cwd: string;
  /** The user's Claude Code binary — passed as pathToClaudeCodeExecutable. */
  claudePath: string;
  /** Packaged pome-setup skill directory (contains SKILL.md). */
  skillSourceDir: string;
  /** The provisioned SDK's query(). Injected — the test seam. */
  query: AgentSdkQueryFn;
  /** [y/N] prompt. */
  confirm: (question: string) => Promise<boolean>;
  /** Line sink, default console.error. */
  log?: (line: string) => void;
}

export async function runEmbeddedWiring(
  options: EmbeddedWiringOptions,
): Promise<EmbeddedWiringOutcome> {
  const log = options.log ?? ((line: string) => console.error(line));
  const shadow = await mkdtemp(join(tmpdir(), "pome-install-staging-"));
  try {
    const skippedLinks = await populateShadow(options.cwd, shadow);
    if (skippedLinks.length > 0) {
      log(
        `(symlinks stay out of the staged copy: ${skippedLinks.slice(0, 3).join(", ")}${
          skippedLinks.length > 3 ? ` +${skippedLinks.length - 3} more` : ""
        })`,
      );
    }
    await mkdir(join(shadow, ".claude", "skills"), { recursive: true });
    await cp(options.skillSourceDir, join(shadow, ".claude", "skills", "pome-setup"), {
      recursive: true,
    });
    await gitIn(shadow, ["init", "-q"]);
    await gitIn(shadow, ["add", "-A"]);
    await gitIn(shadow, ["commit", "-q", "-m", "pome staging baseline"]);

    const session = await runStagingSession(options, shadow, log);
    if (session.kind === "session-error") return session;

    // Everything the session staged, as one diff — the injected .claude/
    // (skill + any settings the agent might have written) never leaves
    // the shadow.
    await gitIn(shadow, ["add", "-A"]);
    const exclude = [".", `:(exclude).claude`];
    const { stdout: nameStatus } = await gitIn(shadow, [
      "diff",
      "--staged",
      "--name-status",
      "-M",
      "--",
      ...exclude,
    ]);
    const changes = parseNameStatus(nameStatus);
    if (changes.length === 0) {
      return {
        kind: "no-diff",
        reason: session.summary || "the agent session ended without staging any edits",
      };
    }

    const { stdout: numstat } = await gitIn(shadow, [
      "diff",
      "--staged",
      "--numstat",
      "-M",
      "--",
      ...exclude,
    ]);
    const { stdout: patch } = await gitIn(shadow, [
      "diff",
      "--staged",
      "--binary",
      "-M",
      "--",
      ...exclude,
    ]);

    log("");
    log("here's what it will change:");
    log("");
    for (const line of renderFileList(changes, parseNumstat(numstat))) log(line);
    log("");
    for (const line of renderUnifiedDiff(patch)) log(line);
    log("");

    if (!(await options.confirm("apply these changes? [y/N] "))) {
      return { kind: "declined" };
    }

    const patchFile = join(shadow, ".pome-staged.patch");
    await writeFile(patchFile, patch);
    await execFileAsync("git", ["apply", "--whitespace=nowarn", patchFile], {
      cwd: options.cwd,
    });
    log(`✓ wrote ${changes.length} file${changes.length === 1 ? "" : "s"}`);

    return {
      kind: "applied",
      files: changes.length,
      // Any package.json in the tree, not just the root — in a workspace the
      // wiring may add the adapter to a nested package's manifest.
      packageJsonChanged: changes.some(
        (c) => c.path === "package.json" || c.path.endsWith("/package.json"),
      ),
    };
  } finally {
    await rm(shadow, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shadow population

/** Copy the repo into the shadow: tracked + untracked-but-not-ignored files
 *  when git is available, a filtered walk otherwise. `.git` and `.claude`
 *  never cross (see module header), and neither do SYMLINKS: a tracked link
 *  copied verbatim would carry a pointer out of the shadow that the agent's
 *  Read/Write could follow past the canUseTool path fence. Skipped links
 *  are returned so the caller can say so instead of silently dropping them.
 */
async function populateShadow(cwd: string, shadow: string): Promise<string[]> {
  const skippedLinks: string[] = [];
  let files: string[] | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    );
    files = stdout.split("\0").filter(Boolean);
  } catch {
    files = null; // not a git repo (or no git) — fall through to the walk
  }

  if (files) {
    for (const file of files) {
      if (file === ".claude" || file.startsWith(`.claude${sep}`) || file.startsWith(".claude/")) {
        continue;
      }
      const from = join(cwd, file);
      let stat;
      try {
        stat = await lstat(from);
      } catch {
        continue; // ls-files can list deleted-but-tracked paths
      }
      if (stat.isSymbolicLink()) {
        skippedLinks.push(file);
        continue;
      }
      if (!stat.isFile()) continue;
      const to = join(shadow, file);
      await mkdir(join(to, ".."), { recursive: true });
      await cp(from, to, { recursive: false, verbatimSymlinks: true });
    }
    return skippedLinks;
  }

  const SKIP = new Set([".git", ".claude", "node_modules"]);
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(cwd, rel), { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        // Dirent methods don't dereference — mirror the git branch: skip
        // links (whether they point at files or directories) and say so.
        skippedLinks.push(childRel);
      } else if (entry.isDirectory()) {
        await mkdir(join(shadow, childRel), { recursive: true });
        await walk(childRel);
      } else if (entry.isFile()) {
        await mkdir(join(shadow, childRel, ".."), { recursive: true });
        await cp(join(cwd, childRel), join(shadow, childRel));
      }
    }
  };
  await walk("");
  return skippedLinks;
}

function gitIn(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    "git",
    [
      // The shadow is throwaway: never touch the user's git identity/config.
      "-c",
      "user.email=install@pome.sh",
      "-c",
      "user.name=pome install",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  );
}

// ---------------------------------------------------------------------------
// The staging session

async function runStagingSession(
  options: EmbeddedWiringOptions,
  shadow: string,
  log: (line: string) => void,
): Promise<{ kind: "ok"; summary: string } | { kind: "session-error"; reason: string }> {
  const canUseTool = buildStagingCanUseTool(shadow, log);
  let summary = "";
  let sessionError: string | null = null;

  const iterator = options.query({
    prompt: EMBEDDED_KICKOFF_PROMPT,
    options: {
      cwd: shadow,
      pathToClaudeCodeExecutable: options.claudePath,
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Load the injected pome-setup skill from the shadow's .claude/skills.
      settingSources: ["project"],
      skills: "all",
      tools: [...STAGING_TOOLS],
      maxTurns: 80,
      canUseTool,
    },
  });

  try {
    for await (const message of iterator) {
      const type = message.type as string | undefined;
      if (type === "assistant") {
        for (const line of assistantTextLines(message)) log(dim(`  ${line}`));
      } else if (type === "result") {
        const subtype = message.subtype as string | undefined;
        if (subtype === "success") {
          summary = typeof message.result === "string" ? message.result.trim() : "";
        } else {
          const errors = Array.isArray(message.errors) ? message.errors.join("; ") : subtype;
          sessionError = `agent session ended without finishing: ${errors ?? "unknown error"}`;
        }
      }
    }
  } catch (err) {
    // The SDK's iterator throws after error results (max turns, process
    // exit). The result message above is the source of truth when we got
    // one; otherwise surface the thrown reason.
    if (!sessionError && !summary) {
      sessionError = `agent session failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (sessionError) return { kind: "session-error", reason: sessionError };
  return { kind: "ok", summary };
}

/** Path-confining permission gate. Exported for direct unit tests. */
export function buildStagingCanUseTool(
  shadowRoot: string,
  log: (line: string) => void,
): (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
> {
  const allowed = new Set<string>(STAGING_TOOLS);
  const resolvedRoot = resolve(shadowRoot);

  // Compare in canonical (symlink-resolved) space on both sides — on macOS
  // the tmpdir shadow itself sits behind /var → /private/var. For paths that
  // don't exist yet (a Write creating a file), canonicalize the nearest
  // existing ancestor and re-append the remainder.
  const canonicalize = (abs: string): string => {
    let probe = abs;
    while (!existsSync(probe)) {
      const parent = resolve(probe, "..");
      if (parent === probe) break;
      probe = parent;
    }
    return join(realpathSync(probe), relative(probe, abs));
  };
  const root = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;

  const contained = (abs: string): boolean => {
    const rel = relative(root, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };

  const insideShadow = (p: unknown): boolean => {
    if (typeof p !== "string" || p.length === 0) return true; // no path arg — cwd-scoped
    const abs = isAbsolute(p) ? resolve(p) : resolve(resolvedRoot, p);
    // Defense in depth: symlinks never cross into the shadow (populateShadow
    // skips them), but canonicalizing means a link that appears anyway can't
    // smuggle the operation outside.
    try {
      return contained(canonicalize(abs));
    } catch {
      return false;
    }
  };

  return async (toolName, input) => {
    if (!allowed.has(toolName)) {
      return {
        behavior: "deny",
        message:
          `${toolName} is not available in this pome staging session. ` +
          "Make wiring edits with Read/Edit/Write only; pome runs installs and " +
          "verification after the diff is approved.",
      };
    }
    for (const key of ["file_path", "notebook_path", "path"]) {
      if (key in input && !insideShadow(input[key])) {
        return {
          behavior: "deny",
          message:
            `${String(input[key])} is outside the repository being wired. ` +
            "Only files inside the working directory may be read or edited.",
        };
      }
    }
    if (toolName === "Edit" || toolName === "Write") {
      const p = String(input.file_path ?? "");
      const abs = isAbsolute(p) ? resolve(p) : resolve(resolvedRoot, p);
      let rel: string;
      try {
        rel = relative(root, canonicalize(abs));
      } catch {
        rel = p;
      }
      log(dim(`  staged ${rel}`));
    }
    return { behavior: "allow", updatedInput: input };
  };
}

function assistantTextLines(message: Record<string, unknown>): string[] {
  const inner = message.message as { content?: unknown } | undefined;
  if (!inner || !Array.isArray(inner.content)) return [];
  const lines: string[] = [];
  for (const block of inner.content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text ?? "";
      for (const line of text.split("\n")) {
        if (line.trim()) lines.push(line.trimEnd());
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Rendering (CLI moments 02)

interface Change {
  status: "modified" | "new file" | "deleted" | "renamed";
  path: string;
  from?: string;
}

function parseNameStatus(out: string): Change[] {
  const changes: Change[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    if (code.startsWith("R")) {
      changes.push({ status: "renamed", from: parts[1], path: parts[2] ?? "" });
    } else if (code === "A") {
      changes.push({ status: "new file", path: parts[1] ?? "" });
    } else if (code === "D") {
      changes.push({ status: "deleted", path: parts[1] ?? "" });
    } else {
      changes.push({ status: "modified", path: parts[1] ?? "" });
    }
  }
  return changes;
}

function parseNumstat(out: string): Map<string, { added: number; removed: number }> {
  const stats = new Map<string, { added: number; removed: number }>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, ...rest] = line.split("\t");
    let path = rest.join("\t");
    // Renames appear as "old => new" or "prefix{old => new}suffix" — key by
    // the new path, matching name-status.
    const arrow = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (arrow) path = `${arrow[1]}${arrow[3]}${arrow[4]}`;
    else if (path.includes(" => ")) path = path.split(" => ")[1] ?? path;
    stats.set(path, {
      added: added === "-" ? 0 : Number(added),
      removed: removed === "-" ? 0 : Number(removed),
    });
  }
  return stats;
}

function renderFileList(
  changes: Change[],
  stats: Map<string, { added: number; removed: number }>,
): string[] {
  const width = Math.max(...changes.map((c) => c.status.length));
  return changes.map((c) => {
    const stat = stats.get(c.path);
    const counts = stat
      ? [stat.added > 0 ? `+${stat.added}` : "", stat.removed > 0 ? `−${stat.removed}` : ""]
          .filter(Boolean)
          .join(" ")
      : "";
    const name = c.status === "renamed" && c.from ? `${c.from} → ${c.path}` : c.path;
    return `  ${c.status.padEnd(width)}  ${name}${counts ? `  ${counts}` : ""}`;
  });
}

function useColor(): boolean {
  return Boolean(process.stderr.isTTY && !process.env.NO_COLOR);
}

function dim(s: string): string {
  return useColor() ? `\x1b[2m${s}\x1b[0m` : s;
}

function renderUnifiedDiff(patch: string): string[] {
  const color = useColor();
  const paint = (line: string): string => {
    if (!color) return line;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) {
      return `\x1b[1m${line}\x1b[0m`;
    }
    if (line.startsWith("@@")) return `\x1b[36m${line}\x1b[0m`;
    if (line.startsWith("+")) return `\x1b[32m${line}\x1b[0m`;
    if (line.startsWith("-")) return `\x1b[31m${line}\x1b[0m`;
    if (line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted")) {
      return `\x1b[2m${line}\x1b[0m`;
    }
    return line;
  };
  return patch
    .split("\n")
    .filter((line, i, arr) => !(line === "" && i === arr.length - 1))
    .map(paint);
}
