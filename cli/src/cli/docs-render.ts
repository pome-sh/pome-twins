// SPDX-License-Identifier: Apache-2.0
/**
 * Renders bundled Mintlify-author Markdown/MDX (from this package) for ANSI terminals.
 * We intentionally do not fetch docs.pome.sh — the HTML/Mintlify pipeline is web-only; the CLI
 * ships parallel source files listed in docs-topics.ts so slugs stay aligned with docs.json.
 */

export interface DocSection {
  /** Heading text without "## " */
  heading: string;
  /** Body including the original markdown (minus outer heading line). */
  bodyLines: string[];
}

export interface PreparedDoc {
  /** Full document after frontmatter + heavy MDX stripping, still markdown-ish. */
  plainLines: string[];
  sections: DocSection[];
}

const MDX_BLOCK_OPEN = [
  "CardGroup",
  "Card",
  "Tabs",
  "Tab",
  "Steps",
  "Step",
  "AccordionGroup",
  "Accordion",
  "Frame",
  "Tip",
  "Note",
  "Warning",
  "Check",
];

export function stripYamlFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return raw;
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return raw;
  const rest = raw.slice(end + "\n---".length).replace(/^\s*\n/, "");
  return rest;
}

/** Drop MDX layout components; keep plain markdown + inner text from simple wrappers like Update. */
export function stripHeavyMdx(source: string): string {
  let s = source;
  for (const tag of MDX_BLOCK_OPEN) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    s = s.replace(re, "");
  }
  s = s.replace(/<Card\b[^/]*?\/>/gi, "");
  s = s.replace(
    /<Update\b[^>]*>([\s\S]*?)<\/Update>/gi,
    (_m, inner: string) => `\n${inner.trim()}\n`,
  );
  s = s.replace(/<[A-Z][A-Za-z0-9]*\b[^/]*?\/>/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim() + "\n";
}

export function splitSections(markdown: string): PreparedDoc {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let firstH2 = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## .+$/.test(lines[i]!)) {
      firstH2 = i;
      break;
    }
  }

  if (firstH2 === -1) {
    return {
      plainLines: lines,
      sections: [{ heading: "Document", bodyLines: [...lines] }],
    };
  }

  const sections: DocSection[] = [];
  const preamble = lines.slice(0, firstH2);
  if (preamble.some((l) => l.trim().length > 0)) {
    sections.push({ heading: "Overview", bodyLines: preamble });
  }

  let current: DocSection | null = null;
  for (let i = firstH2; i < lines.length; i++) {
    const line = lines[i]!;
    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      if (current) sections.push(current);
      current = { heading: h2[1]!.trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) sections.push(current);

  if (sections.length === 0) {
    sections.push({ heading: "Document", bodyLines: lines });
  }
  return { plainLines: lines, sections };
}

export function prepareDocSource(raw: string): PreparedDoc {
  const noFront = stripYamlFrontmatter(raw);
  const stripped = stripHeavyMdx(noFront);
  return splitSections(stripped);
}

function flattenSection(sec: DocSection): string[] {
  return [`## ${sec.heading}`, ...sec.bodyLines];
}


export function formatInlineForTerminal(line: string, useColor: boolean): string {
  let s = line;
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    if (useColor) {
      return `\x1b[1m${label}\x1b[0m (\x1b[2m${url}\x1b[0m)`;
    }
    return `${label} (${url})`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) =>
    useColor ? `\x1b[1m${t}\x1b[0m` : t,
  );
  s = s.replace(/`([^`]+)`/g, (_m, t: string) =>
    useColor ? `\x1b[36m${t}\x1b[0m` : `\`${t}\``,
  );
  return s;
}

export function renderMarkdownLines(
  lines: string[],
  options: {
    useColor: boolean;
    width: number;
    /** Skip "## heading" lines — caller prints them differently */
    skipH2: boolean;
  },
): string[] {
  const out: string[] = [];
  let inFence = false;

  for (let rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      out.push(
        options.useColor
          ? `\x1b[2m${line.trimEnd()}\x1b[0m`
          : line.trimEnd(),
      );
      continue;
    }
    if (inFence) {
      const prefix = options.useColor ? "\x1b[2m" : "";
      const suffix = options.useColor ? "\x1b[0m" : "";
      for (const wrapped of wrapLine(line, options.width - 2)) {
        out.push(`${prefix}  ${wrapped}${suffix}`);
      }
      continue;
    }
    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      if (options.skipH2) continue;
      const text = formatInlineForTerminal(h2[1]!, options.useColor);
      out.push(
        options.useColor ? `\x1b[1m## ${text}\x1b[0m` : `## ${text}`,
      );
      continue;
    }
    const h3 = line.match(/^### (.+)$/);
    if (h3) {
      const text = formatInlineForTerminal(h3[1]!, options.useColor);
      out.push(
        options.useColor
          ? `\x1b[1m  ${text}\x1b[0m`
          : `  ${text}`,
      );
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    const formatted = formatInlineForTerminal(line, options.useColor);
    for (const w of wrapLine(formatted, options.width)) {
      out.push(w);
    }
  }

  return out;
}

function wrapLine(text: string, width: number): string[] {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripAnsi(text).length <= width) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur.length === 0 ? w : `${cur} ${w}`;
    if (stripAnsi(next).length > width) {
      if (cur.length > 0) lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

export function renderFullDocument(
  prepared: PreparedDoc,
  options: { useColor: boolean; width: number },
): string[] {
  return renderMarkdownLines(prepared.plainLines, {
    ...options,
    skipH2: false,
  });
}

export function renderSingleSection(
  prepared: PreparedDoc,
  index: number,
  options: { useColor: boolean; width: number },
): string[] | null {
  const sec = prepared.sections[index];
  if (!sec) return null;
  const lines = flattenSection(sec);
  return renderMarkdownLines(lines, { ...options, skipH2: false });
}

export function sectionMenuLabel(sec: DocSection): string {
  return sec.heading;
}
