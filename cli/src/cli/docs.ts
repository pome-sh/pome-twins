// SPDX-License-Identifier: Apache-2.0
/**
 * `pome docs` — terminal-first documentation.
 *
 * **Help surfaces** (see also docs/HELP-SURFACES.md):
 * - `pome --help` / `pome help` — Commander-generated flag + subcommand reference (terse).
 * - `pome docs [topic]` — narrative Mintlify docs, rendered from bundled sources in this package.
 * - `pome <cmd> --help` — per-command options.
 *
 * We use a **structured index** (`docs-topics.ts`) plus **bundled Markdown/MDX** sources
 * rather than fetching Mintlify HTML (see header comment in docs-topics.ts).
 */
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_DOCS_SITE_ORIGIN } from "./defaults.js";
import { DOCS_TOPICS, type DocsTopic } from "./docs-topics.js";
import { resolvePackageRoot } from "./resolve-package-root.js";
import {
  prepareDocSource,
  renderFullDocument,
  renderSingleSection,
  sectionMenuLabel,
} from "./docs-render.js";

function useColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function dim(s: string): string {
  return useColor() ? `\x1b[2m${s}\x1b[0m` : s;
}

function bold(s: string): string {
  return useColor() ? `\x1b[1m${s}\x1b[0m` : s;
}

function wrapLine(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur.length === 0 ? w : `${cur} ${w}`;
    if (next.length > width) {
      if (cur.length > 0) lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

export function findTopic(raw: string, topics: DocsTopic[]): DocsTopic | null {
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  const byId = topics.find((t) => t.id === q);
  if (byId) return byId;
  const byKw = topics.find((t) =>
    t.keywords.some((k) => k.toLowerCase() === q || q.includes(k.toLowerCase())),
  );
  if (byKw) return byKw;
  const fuzzy = topics.find(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.id.includes(q) ||
      t.path.toLowerCase().includes(q),
  );
  return fuzzy ?? null;
}

export function suggestTopics(raw: string, topics: DocsTopic[]): string {
  const q = raw.trim().toLowerCase();
  const scored = topics
    .map((t) => {
      let score = 0;
      if (t.id.startsWith(q)) score += 3;
      for (const k of t.keywords) {
        if (k.startsWith(q)) score += 2;
        if (k.includes(q)) score += 1;
      }
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.t.id);
  if (scored.length === 0) {
    return `Unknown docs topic "${raw}". Run \`pome docs\` for the index.`;
  }
  return `Unknown docs topic "${raw}". Did you mean: ${scored.join(", ")}?`;
}

function topicMatchesFilter(t: DocsTopic, filter: string): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return (
    t.id.includes(f) ||
    t.title.toLowerCase().includes(f) ||
    t.keywords.some((k) => k.toLowerCase().includes(f)) ||
    t.path.toLowerCase().includes(f)
  );
}

async function readTopicSource(topic: DocsTopic): Promise<string | null> {
  const root = resolvePackageRoot(import.meta.url);
  if (!root) return null;
  try {
    return await readFile(join(root, topic.sourceFile), "utf8");
  } catch {
    return null;
  }
}

function printDocFooter(url: string, topic: DocsTopic): void {
  console.log("");
  console.log(dim(`Web: ${url}`));
  console.log(dim(`Source file: ${topic.sourceFile} (bundled with this package)`));
}

async function promptLine(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return await new Promise((resolve) => rl.question(q, resolve));
}

async function browseSections(
  topic: DocsTopic,
  site: string,
  width: number,
  colored: boolean,
): Promise<void> {
  const raw = await readTopicSource(topic);
  if (!raw) {
    console.error(
      `Could not read ${topic.sourceFile} from the installed package — printing URL only.`,
    );
    console.log(`${site}${topic.path}`);
    process.exitCode = 2;
    return;
  }

  const prepared = prepareDocSource(raw);
  const url = `${site}${topic.path}`;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      console.log("");
      console.log(bold(`${topic.title} — sections`));
      console.log(dim(`0  Full document`));
      prepared.sections.forEach((sec, i) => {
        console.log(dim(`${i + 1}  `) + sectionMenuLabel(sec));
      });
      console.log(dim(`b  Back to topic list`));
      const pick = (await promptLine(rl, dim("Choice: "))).trim().toLowerCase();
      if (pick === "b" || pick === "q") return;
      if (pick === "0") {
        const lines = renderFullDocument(prepared, { useColor: colored, width });
        console.log("");
        for (const ln of lines) console.log(ln);
        printDocFooter(url, topic);
        await promptLine(rl, dim("Enter to continue… "));
        continue;
      }
      const n = Number.parseInt(pick, 10);
      if (!Number.isFinite(n) || n < 1 || n > prepared.sections.length) {
        console.error(dim("Unrecognized choice."));
        continue;
      }
      const lines = renderSingleSection(prepared, n - 1, {
        useColor: colored,
        width,
      });
      console.log("");
      if (lines) for (const ln of lines) console.log(ln);
      printDocFooter(url, topic);
      await promptLine(rl, dim("Enter to continue… "));
    }
  } finally {
    rl.close();
  }
}

export async function runDocsCommand(
  topicArg: string | undefined,
  opts: { site?: string; urlOnly?: boolean },
): Promise<void> {
  const site = (opts.site ?? DEFAULT_DOCS_SITE_ORIGIN).replace(/\/$/, "");
  const width = Math.max(40, Math.min(100, process.stdout.columns ?? 80));
  const colored = useColor();
  const ttyIn = process.stdin.isTTY === true;
  const ttyOut = process.stdout.isTTY === true;
  const interactive = ttyIn && ttyOut && !topicArg && !opts.urlOnly;

  if (topicArg) {
    const match = findTopic(topicArg, DOCS_TOPICS);
    if (!match) {
      console.error(suggestTopics(topicArg, DOCS_TOPICS));
      process.exitCode = 2;
      return;
    }
    const url = `${site}${match.path}`;
    if (opts.urlOnly || !ttyOut) {
      console.log(url);
      return;
    }
    const raw = await readTopicSource(match);
    if (!raw) {
      console.error(`Missing bundled doc source: ${match.sourceFile}`);
      console.log(url);
      process.exitCode = 2;
      return;
    }
    const prepared = prepareDocSource(raw);
    const lines = renderFullDocument(prepared, { useColor: colored, width });
    for (const ln of lines) console.log(ln);
    printDocFooter(url, match);
    return;
  }

  if (!ttyOut || opts.urlOnly) {
    for (const t of DOCS_TOPICS) {
      console.log(`${t.id}\t${site}${t.path}`);
    }
    return;
  }

  console.log(bold("Pome docs"));
  console.log(
    dim(
      "Terminal view: bundled Mintlify sources · URLs match docs.pome.sh · " +
        "`pome --help` lists commands; this is narrative docs.",
    ),
  );
  console.log(
    dim(
      "Example: `pome docs getting-started` prints the install + first-run path in your terminal.",
    ),
  );
  console.log("");

  if (!interactive) {
    let i = 1;
    for (const t of DOCS_TOPICS) {
      const title = `${i}. ${t.title} ${dim(`(${t.id})`)}`;
      console.log(title);
      for (const line of wrapLine(`${site}${t.path}`, width - 2)) {
        console.log(`   ${dim(line)}`);
      }
      console.log("");
      i += 1;
    }
    console.log(dim("Non-interactive stdin: id<TAB>url lines were printed on stdout above."));
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let filter = "";

  try {
    while (true) {
      const list = DOCS_TOPICS.filter((t) => topicMatchesFilter(t, filter));
      console.log(
        filter
          ? dim(`Filter: "${filter}" (${list.length} topics) — Enter clears filter`)
          : dim("Type to filter topics (substring), a number to open, topic id, or Enter to clear filter / exit"),
      );
      list.forEach((t, idx) => {
        console.log(`${dim(`${idx + 1}.`)} ${t.title} ${dim(`(${t.id})`)}`);
      });
      if (list.length === 0) {
        console.log(dim("(no matches — edit filter)"));
      }
      const answer = (await promptLine(rl, dim("› "))).trim();

      if (answer === "") {
        if (filter) {
          filter = "";
          continue;
        }
        return;
      }

      const direct = findTopic(answer, DOCS_TOPICS);
      if (direct && (list.includes(direct) || filter === "")) {
        await browseSections(direct, site, width, colored);
        filter = "";
        continue;
      }

      const n = Number.parseInt(answer, 10);
      if (
        Number.isFinite(n) &&
        n >= 1 &&
        n <= list.length &&
        answer === String(n)
      ) {
        await browseSections(list[n - 1]!, site, width, colored);
        filter = "";
        continue;
      }

      filter = answer;
    }
  } finally {
    rl.close();
  }
}
