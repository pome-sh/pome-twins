// SPDX-License-Identifier: Apache-2.0
//
// Structured fidelity inventory (F-730). Each twin ships a machine-readable
// surface list — `fidelity.inventory.json` — carrying, per MCP tool and REST
// surface, the heat tier (how deep the endpoint SHOULD be, ruled by the
// F-729 rubric) orthogonal to the fidelity tier (how deep it IS, per
// `fidelityTierSchema`), plus a justification for the classification.
//
// The FIDELITY doc tables are 1:1-linted against this inventory instead of
// the old soft "docs mention the tool name" checks (which let twin-stripe's
// implemented-but-undocumented refunds drift by silently). Known, ticketed
// doc gaps are declared in `doc_drift`: the lint accepts exactly those
// gaps and fails loudly once the docs catch up, so a declaration can never
// outlive the drift it describes.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { fidelityTierSchema } from "./index.js";

export const heatTierSchema = z.enum(["hot", "warm", "cold", "unclassified"]);
export type HeatTier = z.infer<typeof heatTierSchema>;

export const fidelitySurfaceSchema = z.strictObject({
  /** MCP tool name, or the REST surface string exactly as documented. */
  name: z.string().min(1),
  heat: heatTierSchema,
  fidelity: fidelityTierSchema,
  justification: z.string().min(1),
});
export type FidelitySurface = z.infer<typeof fidelitySurfaceSchema>;

export const fidelityDocDriftSchema = z.strictObject({
  kind: z.enum(["tool", "rest"]),
  /** Must match an inventory entry of the same kind. */
  name: z.string().min(1),
  reason: z.string().min(1),
  /** The Linear ticket that owns reconciling the docs. */
  ticket: z.string().regex(/^F-\d+$/),
});
export type FidelityDocDrift = z.infer<typeof fidelityDocDriftSchema>;

export const fidelityInventorySchema = z.strictObject({
  twin: z.string().min(1),
  package: z.string().min(1),
  /** ISO date (YYYY-MM-DD) of the last human review of this inventory. */
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().optional(),
  tools: z.array(fidelitySurfaceSchema).min(1),
  rest: z.array(fidelitySurfaceSchema),
  doc_drift: z.array(fidelityDocDriftSchema).default([]),
});
export type FidelityInventory = z.infer<typeof fidelityInventorySchema>;

export function loadFidelityInventory(path: string): FidelityInventory {
  return fidelityInventorySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

// ─── FIDELITY doc table parsing ──────────────────────────────────────────────

export interface FidelityDocRow {
  name: string;
  fidelity: string;
}

export interface FidelityDocSource {
  /** Shown in lint problems, e.g. "FIDELITY.md". */
  label: string;
  kind: "tool" | "rest";
  markdown: string;
}

const TOOL_NAME_HEADERS = new Set(["tool"]);
const REST_NAME_HEADERS = new Set(["route", "endpoint", "surface"]);

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * Expand one name cell into surface names. Backticked spans are the names;
 * a span with no `.`, `/`, or space is shorthand for a sibling of the first
 * span (Slack-style `` `reactions.add` / `remove` / `get` ``) and inherits
 * its dotted prefix. Cells with no backticks name the surface verbatim
 * (e.g. "Any unsupported path").
 */
export function expandSurfaceCell(cell: string): string[] {
  const spans = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
  if (spans.length === 0) {
    const text = cell.trim();
    return text.length > 0 ? [text] : [];
  }
  const [first, ...rest] = spans;
  const lastDot = first.lastIndexOf(".");
  const prefix = lastDot >= 0 ? first.slice(0, lastDot + 1) : "";
  return [
    first,
    ...rest.map((span) =>
      /[./ ]/.test(span) || prefix === "" ? span : `${prefix}${span}`
    ),
  ];
}

/** Parse every markdown table whose header names surfaces of `kind` + Tier. */
export function parseFidelityDocRows(markdown: string, kind: "tool" | "rest"): FidelityDocRow[] {
  const nameHeaders = kind === "tool" ? TOOL_NAME_HEADERS : REST_NAME_HEADERS;
  const rows: FidelityDocRow[] = [];
  const lines = markdown.split("\n");
  let nameIdx = -1;
  let tierIdx = -1;
  let inTable = false;
  for (const line of lines) {
    if (!line.trimStart().startsWith("|")) {
      inTable = false;
      nameIdx = -1;
      tierIdx = -1;
      continue;
    }
    const cells = splitTableRow(line);
    if (!inTable) {
      const headers = cells.map((cell) => cell.toLowerCase());
      nameIdx = headers.findIndex((header) => nameHeaders.has(header));
      tierIdx = headers.findIndex((header) => header === "tier");
      inTable = true;
      continue;
    }
    if (isSeparatorRow(cells) || nameIdx < 0 || tierIdx < 0) continue;
    const fidelity = cells[tierIdx] ?? "";
    for (const name of expandSurfaceCell(cells[nameIdx] ?? "")) {
      rows.push({ name, fidelity });
    }
  }
  return rows;
}

// ─── Lint: inventory ⇔ docs, both directions ─────────────────────────────────

/**
 * 1:1-lint the inventory against the FIDELITY doc tables. Returns human-
 * readable problems (empty = clean). Directions checked per kind:
 * every doc row must be in the inventory with the same fidelity tier, and
 * every inventory entry must be documented unless a `doc_drift` entry
 * (with its owning ticket) declares the gap. A drift declaration whose
 * name IS documented is stale and reported, so drift entries self-expire.
 */
export function lintFidelityInventory(
  inventory: FidelityInventory,
  docs: FidelityDocSource[]
): string[] {
  const problems: string[] = [];
  for (const kind of ["tool", "rest"] as const) {
    const sources = docs.filter((doc) => doc.kind === kind);
    if (sources.length === 0) continue;
    const labels = sources.map((doc) => doc.label).join(", ");
    const entries = kind === "tool" ? inventory.tools : inventory.rest;
    const drift = new Map(
      inventory.doc_drift.filter((d) => d.kind === kind).map((d) => [d.name, d])
    );

    const inventoryByName = new Map<string, FidelitySurface>();
    for (const entry of entries) {
      if (inventoryByName.has(entry.name)) {
        problems.push(`inventory ${kind} '${entry.name}' is listed twice`);
      }
      inventoryByName.set(entry.name, entry);
    }

    const documented = new Map<string, FidelityDocRow>();
    for (const source of sources) {
      for (const row of parseFidelityDocRows(source.markdown, kind)) {
        documented.set(row.name, row);
      }
    }

    for (const [name, row] of documented) {
      const entry = inventoryByName.get(name);
      if (!entry) {
        problems.push(`${labels}: ${kind} '${name}' documented but missing from fidelity.inventory.json`);
        continue;
      }
      if (entry.fidelity !== row.fidelity) {
        problems.push(
          `${kind} '${name}': inventory says fidelity '${entry.fidelity}' but ${labels} says '${row.fidelity}'`
        );
      }
    }

    for (const entry of entries) {
      if (documented.has(entry.name)) continue;
      const declared = drift.get(entry.name);
      if (!declared) {
        problems.push(
          `${kind} '${entry.name}' is in fidelity.inventory.json but undocumented in ${labels}; add the row or declare doc_drift`
        );
      }
    }

    for (const declared of drift.values()) {
      if (!inventoryByName.has(declared.name)) {
        problems.push(
          `doc_drift ${kind} '${declared.name}' (${declared.ticket}) matches no inventory entry`
        );
      }
      if (documented.has(declared.name)) {
        problems.push(
          `doc_drift ${kind} '${declared.name}' (${declared.ticket}) is stale — ${labels} now documents it; remove the declaration`
        );
      }
    }
  }
  return problems;
}

/** Set-compare tool names: inventory vs the live `listTools()` surface. */
export function compareToolNames(
  inventoryNames: string[],
  liveNames: string[]
): { missing: string[]; extra: string[] } {
  const inventory = new Set(inventoryNames);
  const live = new Set(liveNames);
  return {
    missing: [...live].filter((name) => !inventory.has(name)).sort(),
    extra: [...inventory].filter((name) => !live.has(name)).sort(),
  };
}
