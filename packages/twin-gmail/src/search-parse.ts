// SPDX-License-Identifier: Apache-2.0
import { invalidArgument } from "./errors.js";

export type SearchNode =
  | { type: "and"; children: SearchNode[] }
  | { type: "or"; children: SearchNode[] }
  | { type: "not"; child: SearchNode }
  | { type: "term"; field?: string; value: string; exact?: boolean }
  | { type: "around"; left: string; right: string; distance: number };

export type SearchDocument = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  deliveredTo: string;
  subject: string;
  text: string;
  html: string;
  dateMs: number;
  rfcMessageId: string;
  size: number;
  labels: string[];
  userLabelCount: number;
  attachmentNames: string[];
  attachmentMimeTypes: string[];
  headers: Array<{ name: string; value: string }>;
};

const MAX_QUERY_BYTES = 4096;
const MAX_TOKENS = 256;
const MAX_DEPTH = 20;
const MAX_BRANCHES = 256;

/**
 * Hard mailbox-size budget for the intentional in-memory search evaluator.
 * Search hydrates semantic rows in process; exceeding this fails loudly before OOM.
 */
export const SEARCH_MAILBOX_MESSAGE_BUDGET = 10_000;

/** Operators supported by the twin search grammar (unknowns are rejected). */
export const KNOWN_FIELDS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "deliveredto",
  "list",
  "subject",
  "rfc822msgid",
  "filename",
  "after",
  "newer",
  "before",
  "older",
  "newer_than",
  "older_than",
  "size",
  "larger",
  "smaller",
  "label",
  "category",
  "in",
  "is",
  "has",
]);

/** Gmail `category:` aliases → system label ids. */
export const CATEGORY_LABELS: Record<string, string> = {
  primary: "CATEGORY_PERSONAL",
  personal: "CATEGORY_PERSONAL",
  social: "CATEGORY_SOCIAL",
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};

type Token = { value: string; quoted?: boolean };

/**
 * Parse a Gmail query and reject operators/values that would throw at match time
 * (unknown fields, categories, and invalid date/size/duration literals).
 */
export function validateSearchQuery(query: string): SearchNode {
  const node = parseSearchQuery(query);
  const walk = (current: SearchNode): void => {
    switch (current.type) {
      case "and":
      case "or":
        for (const child of current.children) walk(child);
        return;
      case "not":
        walk(current.child);
        return;
      case "around":
        return;
      case "term":
        assertSearchTerm(current.field, current.value);
        return;
    }
  };
  walk(node);
  return node;
}

export function assertSearchTerm(field: string | undefined, value: string): void {
  if (!field) return;
  if (!KNOWN_FIELDS.has(field)) {
    invalidArgument(`Unsupported search operator: ${field}`);
  }
  if (field === "category") {
    if (!CATEGORY_LABELS[value.toLocaleLowerCase("en-US")]) {
      invalidArgument(`Unsupported search category: ${value}`);
    }
    return;
  }
  if (field === "after" || field === "newer" || field === "before" || field === "older") {
    parseDate(value);
    return;
  }
  if (field === "newer_than" || field === "older_than") {
    parseDuration(value);
    return;
  }
  if (field === "size" || field === "larger" || field === "smaller") {
    parseSize(value);
    return;
  }
  if (field === "has") {
    assertHasOperator(value);
  }
}

export function parseSearchQuery(query: string): SearchNode {
  if (Buffer.byteLength(query) > MAX_QUERY_BYTES) invalidArgument("Search query exceeds limit");
  const tokens = tokenize(query);
  if (tokens.length > MAX_TOKENS) invalidArgument("Search query has too many tokens");
  if (tokens.length === 0) return { type: "and", children: [] };
  let position = 0;

  const parseExpression = (depth: number, stop?: string): SearchNode => {
    if (depth > MAX_DEPTH) invalidArgument("Search query nesting exceeds limit");
    const alternatives: SearchNode[] = [];
    let conjunction: SearchNode[] = [];
    const flush = () => {
      alternatives.push(conjunction.length === 1 ? conjunction[0]! : { type: "and", children: conjunction });
      conjunction = [];
    };
    while (position < tokens.length) {
      const token = tokens[position]!;
      if (stop && token.value === stop) break;
      if (token.value.toUpperCase() === "OR") {
        position++;
        if (!conjunction.length) invalidArgument("OR requires a left expression");
        flush();
        continue;
      }
      if (token.value.toUpperCase() === "AND") {
        position++;
        continue;
      }
      conjunction.push(parsePrimary(depth + 1));
    }
    if (conjunction.length) flush();
    if (!alternatives.length) return { type: "and", children: [] };
    return alternatives.length === 1 ? alternatives[0]! : { type: "or", children: alternatives };
  };

  const parsePrimary = (depth: number): SearchNode => {
    const token = tokens[position++]!;
    if (token.value === "(" || token.value === "{") {
      const end = token.value === "(" ? ")" : "}";
      const child = parseExpression(depth, end);
      if (tokens[position]?.value !== end) invalidArgument(`Unclosed ${token.value}`);
      position++;
      return token.value === "{" ? makeImplicitOr(child) : child;
    }
    if (token.value === ")" || token.value === "}") invalidArgument(`Unexpected ${token.value}`);
    let value = token.value;
    let negate = false;
    if (value === "-") {
      negate = true;
      const next = tokens[position++];
      if (!next) invalidArgument("Negation requires an expression");
      position--;
      const child = parsePrimary(depth + 1);
      return { type: "not", child };
    }
    if (value.startsWith("-") && value.length > 1) {
      negate = true;
      value = value.slice(1);
    }

    const around = tokens[position]?.value.toUpperCase() === "AROUND";
    if (around) {
      position++;
      const distance = Number(tokens[position++]?.value);
      const right = tokens[position++]?.value;
      if (!Number.isInteger(distance) || distance < 1 || distance > 100 || !right) {
        invalidArgument("AROUND requires a distance and right term");
      }
      const node: SearchNode = { type: "around", left: value, right, distance };
      return negate ? { type: "not", child: node } : node;
    }

    const colon = value.indexOf(":");
    let node: SearchNode;
    if (colon > 0) {
      const field = value.slice(0, colon).toLowerCase();
      let fieldValue = value.slice(colon + 1);
      if (!fieldValue && (tokens[position]?.value === "(" || tokens[position]?.value === "{")) {
        node = parseFieldGroup(field, depth + 1);
        return negate ? { type: "not", child: node } : node;
      }
      if (!fieldValue && tokens[position] && !["AND", "OR", ")", "}"].includes(tokens[position]!.value.toUpperCase())) {
        fieldValue = tokens[position++]!.value;
      }
      node = { type: "term", field, value: fieldValue, exact: token.quoted };
    } else {
      node = { type: "term", value: value.startsWith("+") ? value.slice(1) : value, exact: token.quoted || value.startsWith("+") };
    }
    return negate ? { type: "not", child: node } : node;
  };

  const parseFieldGroup = (field: string, depth: number): SearchNode => {
    if (depth > MAX_DEPTH) invalidArgument("Search query nesting exceeds limit");
    const opening = tokens[position++]!.value;
    const end = opening === "(" ? ")" : "}";
    const groups: SearchNode[][] = [[]];
    while (position < tokens.length && tokens[position]!.value !== end) {
      const token = tokens[position++]!;
      if (token.value.toUpperCase() === "OR") {
        groups.push([]);
        continue;
      }
      if (token.value.toUpperCase() === "AND") continue;
      if (["(", "{", ")", "}"].includes(token.value)) invalidArgument("Nested field groups are unsupported");
      let value = token.value;
      let negate = false;
      if (value.startsWith("-")) {
        negate = true;
        value = value.slice(1);
      }
      const term: SearchNode = { type: "term", field, value, exact: token.quoted };
      groups.at(-1)!.push(negate ? { type: "not", child: term } : term);
    }
    if (tokens[position]?.value !== end) invalidArgument(`Unclosed ${opening}`);
    position++;
    const nodes = groups.map((children) =>
      children.length === 1 ? children[0]! : ({ type: "and", children } satisfies SearchNode)
    );
    const useOr = opening === "{" || nodes.length > 1;
    return useOr ? { type: "or", children: nodes } : nodes[0] ?? { type: "and", children: [] };
  };

  const root = parseExpression(0);
  if (position !== tokens.length) invalidArgument("Unexpected search token");
  if (countBranches(root) > MAX_BRANCHES) invalidArgument("Search query has too many branches");
  return root;
}

export function assertHasOperator(value: string): void {
  const normalized = value.toLocaleLowerCase("en-US");
  if (normalized.endsWith("-star")) {
    invalidArgument(
      `Unsupported colored-star operator: has:${value}; twin maps only STARRED via is:starred`
    );
  }
}

export function parseDate(value: string): number {
  const normalized = /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(value) ? value.replaceAll("/", "-") : value;
  const date = Date.parse(`${normalized}${/^\d{4}-\d/.test(normalized) ? "T00:00:00Z" : ""}`);
  if (Number.isNaN(date)) invalidArgument(`Invalid search date: ${value}`);
  return date;
}

export function parseDuration(value: string): number {
  const match = value.match(/^(\d+)([dmy])$/i);
  if (!match) invalidArgument(`Invalid search duration: ${value}`);
  const units = { d: 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 } as const;
  return Number(match[1]) * units[match[2]!.toLowerCase() as keyof typeof units];
}

export function parseSize(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)([kmg])?$/i);
  if (!match) invalidArgument(`Invalid search size: ${value}`);
  const scale = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const;
  return Math.floor(Number(match[1]) * (match[2] ? scale[match[2].toLowerCase() as keyof typeof scale] : 1));
}

function countBranches(node: SearchNode): number {
  switch (node.type) {
    case "and":
    case "or":
      return node.children.reduce((sum, child) => sum + countBranches(child), 0);
    case "not":
      return countBranches(node.child);
    case "around":
    case "term":
      return 1;
  }
}

function tokenize(query: string): Token[] {
  const out: Token[] = [];
  let index = 0;
  while (index < query.length) {
    if (/\s/.test(query[index]!)) {
      index++;
      continue;
    }
    const char = query[index]!;
    if ("(){}".includes(char)) {
      out.push({ value: char });
      index++;
      continue;
    }
    let value = "";
    let quoted = false;
    while (index < query.length && !/\s/.test(query[index]!) && !"(){}".includes(query[index]!)) {
      if (query[index] === '"') {
        quoted = true;
        index++;
        while (index < query.length && query[index] !== '"') {
          if (query[index] === "\\" && index + 1 < query.length) index++;
          value += query[index++]!;
        }
        if (query[index] !== '"') invalidArgument("Unclosed search quote");
        index++;
      } else {
        value += query[index++]!;
      }
    }
    if (value) out.push({ value, quoted });
  }
  return out;
}

function makeImplicitOr(node: SearchNode): SearchNode {
  return node.type === "and" ? { type: "or", children: node.children } : node;
}
