// SPDX-License-Identifier: Apache-2.0
/**
 * `pome docs` — topic-first links to canonical documentation.
 *
 * - `pome --help` / `pome help` — Commander-generated flag + subcommand reference (terse).
 * - `pome docs [topic]` — stable docs.pome.sh URLs for narrative docs.
 * - `pome <cmd> --help` — per-command options.
 */
import { createInterface } from "node:readline";

import { DEFAULT_DOCS_SITE_ORIGIN } from "./defaults.js";
import { DOCS_TOPICS, type DocsTopic } from "./docs-topics.js";

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

async function promptLine(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return await new Promise((resolve) => rl.question(q, resolve));
}

function printTopicUrl(topic: DocsTopic, site: string): void {
  console.log(`${site}${topic.path}`);
}

export async function runDocsCommand(
  topicArg: string | undefined,
  opts: { site?: string; urlOnly?: boolean },
): Promise<void> {
  const site = (opts.site ?? DEFAULT_DOCS_SITE_ORIGIN).replace(/\/$/, "");
  const width = Math.max(40, Math.min(100, process.stdout.columns ?? 80));
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
    printTopicUrl(match, site);
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
      "URL navigator for docs.pome.sh · `pome --help` lists commands; docs.pome.sh hosts narrative docs.",
    ),
  );
  console.log(
    dim(
      "Example: `pome docs getting-started` prints the canonical quickstart URL.",
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
        printTopicUrl(direct, site);
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
        printTopicUrl(list[n - 1]!, site);
        filter = "";
        continue;
      }

      filter = answer;
    }
  } finally {
    rl.close();
  }
}
