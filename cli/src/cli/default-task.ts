// SPDX-License-Identifier: Apache-2.0
// FDRS-645 — "run yours": bare `pome run` (no path) defaults to the demo
// task, closing the demo → run-yours seam (north-star moment 05: their
// agent, k=5, the same task they just watched the demo agent attempt).
//
// The default is a USER-VISIBLE COPY at scenarios/first-run-demo.md, dropped
// on first use from the packaged demo task (src/demo/first-run-demo.md plus
// its compiled seed sidecar — the client parser requires the sidecar when a
// prose ## Seed State section is present). The copy — never the canonical
// packaged md — gains `runs: 5`, so the design's k=5 default rides the
// existing scenario-config `runs` mechanism (an explicit -n still wins) and
// the packaged md stays byte-identical to the server-owned judge definition
// regenerated from it (pome-cloud#209 lockstep).
//
// The packaged md's maintainer comment (the CANONICAL/lockstep warning) is
// swapped for a user-facing one in the copy: the copy is the user's file —
// authenticated runs are judged against the criteria declared in it.

import { constants, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEMO_TASK_NAME, demoTaskPath } from "../demo/task.js";
import { HostedUsageError } from "../hosted/errors.js";

/** Design default k for "run yours" (moment 05: "Their agent · k=5"). */
export const DEFAULT_TASK_TRIALS = 5;

export const DEFAULT_TASK_DIR = "scenarios";

export const DEFAULT_TASK_FILENAME = `${DEMO_TASK_NAME}.md`;

const USER_COPY_COMMENT = `<!--
Copied into your project by \`pome run\` — the "run yours" default: the same
task the demo agent just attempted, now for your agent. This copy is yours.
Edit the prompt/criteria freely (your runs are judged against the criteria
declared in this file), or delete it and the next bare \`pome run\` re-copies
the original. Config pins runs: ${DEFAULT_TASK_TRIALS} — an explicit -n overrides it.
-->`;

/** The ## Config section's fenced yaml block: (heading + everything up to
 *  and including the opening fence line)(fence body)(closing fence). The
 *  gap between heading and fence never crosses into another ## section. */
const CONFIG_FENCE_RE =
  /(##[ \t]*config[^\n]*\n(?:(?!\n##[ \t])[\s\S])*?```(?:yaml)?[ \t]*\n)([\s\S]*?)(```)/i;

export interface DefaultTaskResolution {
  /** Absolute path of the task markdown to run. */
  path: string;
  /** Project-relative path, for terminal copy. */
  relativePath: string;
  /** True when this call dropped the copy (first use). */
  copied: boolean;
  /** False when the packaged md's Config fence couldn't be located, so the
   *  k=5 default could not be pinned into the copy. */
  trialsApplied: boolean;
}

/** Pin `runs: N` inside the ## Config yaml fence. No-op (applied=true) when
 *  the fence already sets runs; applied=false when no fence exists. */
export function withDefaultTrials(
  source: string,
  runs: number = DEFAULT_TASK_TRIALS,
): { content: string; applied: boolean } {
  const match = CONFIG_FENCE_RE.exec(source);
  if (!match) return { content: source, applied: false };
  const [whole, head, body, tail] = match;
  if (/^[ \t]*runs[ \t]*:/m.test(body)) return { content: source, applied: true };
  const glue = body === "" || body.endsWith("\n") ? "" : "\n";
  const content =
    source.slice(0, match.index) +
    head +
    body +
    `${glue}runs: ${runs}\n` +
    tail +
    source.slice(match.index + whole.length);
  return { content, applied: true };
}

/** Swap the packaged maintainer preamble (the CANONICAL/lockstep warning —
 *  true of the packaged md, wrong and confusing in the user's copy) for the
 *  user-facing comment. When no preamble exists, insert after the H1. */
export function withUserCopyComment(source: string): string {
  const commentRe = /<!--[\s\S]*?-->/;
  const comment = commentRe.exec(source);
  const firstSection = source.search(/^##[ \t]/m);
  if (comment && (firstSection === -1 || comment.index < firstSection)) {
    return (
      source.slice(0, comment.index) +
      USER_COPY_COMMENT +
      source.slice(comment.index + comment[0].length)
    );
  }
  const h1 = /^#[ \t].+$/m.exec(source);
  if (!h1) return `${USER_COPY_COMMENT}\n\n${source}`;
  const insertAt = h1.index + h1[0].length;
  return `${source.slice(0, insertAt)}\n\n${USER_COPY_COMMENT}${source.slice(insertAt)}`;
}

/**
 * Resolve the bare-`pome run` default task, dropping the user copy on first
 * use. Never clobbers an existing scenarios/first-run-demo.md — that file is
 * the user's (possibly edited) task from a prior bare run.
 */
export async function ensureDefaultTask(
  cwd: string = process.cwd(),
): Promise<DefaultTaskResolution> {
  const relativePath = join(DEFAULT_TASK_DIR, DEFAULT_TASK_FILENAME);
  const target = join(cwd, relativePath);
  if (existsSync(target)) {
    return { path: target, relativePath, copied: false, trialsApplied: true };
  }

  // A `scenarios` path that exists as a FILE would make the mkdir below
  // throw a raw EEXIST (exit 2). Name the actual problem as a usage error.
  const dir = join(cwd, DEFAULT_TASK_DIR);
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    throw new HostedUsageError(
      `\`${DEFAULT_TASK_DIR}\` exists as a file in this project — the bare \`pome run\` default drops its task into a ${DEFAULT_TASK_DIR}/ directory. Move the file aside, or pass a task path explicitly.`,
    );
  }

  const packagedMd = demoTaskPath();
  const packagedSeed = packagedMd.replace(/\.md$/, ".seed.json");
  if (!existsSync(packagedSeed)) {
    throw new Error(
      `Packaged demo seed not found at ${packagedSeed}. This is a packaging ` +
        "bug — scripts/copy-prompts.mjs ships src/demo/ (task md + seed " +
        "sidecar) into dist/.",
    );
  }

  const raw = await readFile(packagedMd, "utf8");
  const pinned = withDefaultTrials(withUserCopyComment(raw));

  await mkdir(dir, { recursive: true });
  // Seed first, md last: the md's presence is the commit point (the parser
  // hard-requires the sidecar once the md's prose ## Seed State is seen), so
  // a crash between the two writes never strands a half-usable default.
  // COPYFILE_EXCL: NO file under scenarios/ is ever overwritten — a user who
  // deleted only the md but kept an edited seed keeps their seed.
  try {
    await copyFile(
      packagedSeed,
      target.replace(/\.md$/, ".seed.json"),
      constants.COPYFILE_EXCL,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  try {
    // "wx": never overwrite — if a concurrent run raced the copy in, theirs
    // wins and this invocation just runs it.
    await writeFile(target, pinned.content, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { path: target, relativePath, copied: false, trialsApplied: true };
    }
    throw err;
  }
  return { path: target, relativePath, copied: true, trialsApplied: pinned.applied };
}

export function copyAnnounceLine(res: DefaultTaskResolution): string {
  return `copied the demo task into ${res.relativePath} — this copy is yours to edit`;
}

/** Printed when the Config fence couldn't be found in the packaged md, so
 *  the copy runs k=1 unless the user passes -n (honest, never silent). */
export function trialsPinFallbackLine(): string {
  return `couldn't pin runs: ${DEFAULT_TASK_TRIALS} in the copy — pass -n ${DEFAULT_TASK_TRIALS} for the design default`;
}

/** Moment-05 frame ("that was ours, run yours"), printed once the doctor
 *  gate and credential resolution have passed, ahead of the run output. */
export function runYoursFrameLines(): string[] {
  return [
    `run yours · ${DEMO_TASK_NAME}`,
    "that was ours — now it's your agent on the same task the demo just ran.",
  ];
}
