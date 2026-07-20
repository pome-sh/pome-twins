// SPDX-License-Identifier: Apache-2.0

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

type Token = { value: string; quoted?: boolean };

export function parseSearchQuery(query: string): SearchNode {
  if (Buffer.byteLength(query) > MAX_QUERY_BYTES) throw new Error("Search query exceeds limit");
  const tokens = tokenize(query);
  if (tokens.length > MAX_TOKENS) throw new Error("Search query has too many tokens");
  if (tokens.length === 0) return { type: "and", children: [] };
  let position = 0;

  const parseExpression = (depth: number, stop?: string): SearchNode => {
    if (depth > MAX_DEPTH) throw new Error("Search query nesting exceeds limit");
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
        if (!conjunction.length) throw new Error("OR requires a left expression");
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
      if (tokens[position]?.value !== end) throw new Error(`Unclosed ${token.value}`);
      position++;
      return token.value === "{" ? makeImplicitOr(child) : child;
    }
    if (token.value === ")" || token.value === "}") throw new Error(`Unexpected ${token.value}`);
    let value = token.value;
    let negate = false;
    if (value === "-") {
      negate = true;
      const next = tokens[position++];
      if (!next) throw new Error("Negation requires an expression");
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
        throw new Error("AROUND requires a distance and right term");
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
    if (depth > MAX_DEPTH) throw new Error("Search query nesting exceeds limit");
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
      if (["(", "{", ")", "}"].includes(token.value)) throw new Error("Nested field groups are unsupported");
      let value = token.value;
      let negate = false;
      if (value.startsWith("-")) {
        negate = true;
        value = value.slice(1);
      }
      const term: SearchNode = { type: "term", field, value, exact: token.quoted };
      groups.at(-1)!.push(negate ? { type: "not", child: term } : term);
    }
    if (tokens[position]?.value !== end) throw new Error(`Unclosed ${opening}`);
    position++;
    const nodes = groups.map((children) =>
      children.length === 1 ? children[0]! : ({ type: "and", children } satisfies SearchNode)
    );
    const useOr = opening === "{" || nodes.length > 1;
    return useOr ? { type: "or", children: nodes } : nodes[0] ?? { type: "and", children: [] };
  };

  const root = parseExpression(0);
  if (position !== tokens.length) throw new Error("Unexpected search token");
  return root;
}

export function matchesSearch(node: SearchNode, document: SearchDocument, nowMs = Date.now()): boolean {
  switch (node.type) {
    case "and":
      return node.children.every((child) => matchesSearch(child, document, nowMs));
    case "or":
      return node.children.some((child) => matchesSearch(child, document, nowMs));
    case "not":
      return !matchesSearch(node.child, document, nowMs);
    case "around":
      return matchesAround(searchable(document), node.left, node.right, node.distance);
    case "term":
      return matchesTerm(node.field, node.value, node.exact === true, document, nowMs);
  }
}

export function compileSearchToSql(mailboxId: number, node: SearchNode): {
  sql: string;
  params: unknown[];
  predicate: (document: SearchDocument) => boolean;
} {
  // The mailbox read is deliberately fixed SQL. Complex Gmail operators are
  // evaluated against bounded semantic rows; query text is never interpolated.
  return {
    sql: "SELECT * FROM messages WHERE mailbox_id = ? ORDER BY internal_date DESC, id DESC",
    params: [mailboxId],
    predicate: (document) => matchesSearch(node, document),
  };
}

function matchesTerm(
  field: string | undefined,
  rawValue: string,
  exact: boolean,
  document: SearchDocument,
  nowMs: number
): boolean {
  const value = rawValue.toLocaleLowerCase("en-US");
  const contains = (candidate: string) => matchText(candidate, value, exact);
  if (!field) return contains(searchable(document));
  if (field === "from") return contains(document.from);
  if (field === "to") return document.to.some(contains);
  if (field === "cc") return document.cc.some(contains);
  if (field === "bcc") return document.bcc.some(contains);
  if (field === "deliveredto") return contains(document.deliveredTo);
  if (field === "list") {
    return document.headers.some((header) => header.name.toLowerCase() === "list-id" && contains(header.value));
  }
  if (field === "subject") return contains(document.subject);
  if (field === "rfc822msgid") return normalizeMessageId(document.rfcMessageId) === normalizeMessageId(value);
  if (field === "filename") {
    return document.attachmentNames.some(contains) || document.attachmentMimeTypes.some(contains);
  }
  if (field === "after" || field === "newer") return document.dateMs > parseDate(value);
  if (field === "before" || field === "older") return document.dateMs < parseDate(value);
  if (field === "newer_than") return document.dateMs > nowMs - parseDuration(value);
  if (field === "older_than") return document.dateMs < nowMs - parseDuration(value);
  if (field === "size") return document.size === parseSize(value);
  if (field === "larger") return document.size > parseSize(value);
  if (field === "smaller") return document.size < parseSize(value);
  if (field === "label") return hasLabel(document, value);
  if (field === "category") return hasLabel(document, `category_${value}`);
  if (field === "in") return matchesFolder(value, document);
  if (field === "is") return matchesStatus(value, document);
  if (field === "has") return matchesHas(value, document);
  return contains(`${field}:${searchable(document)}`);
}

function matchesFolder(value: string, document: SearchDocument): boolean {
  if (value === "anywhere") return true;
  if (value === "archive") return !hasLabel(document, "inbox");
  if (value === "draft") return hasLabel(document, "draft");
  return hasLabel(document, value);
}

function matchesStatus(value: string, document: SearchDocument): boolean {
  if (value === "read") return !hasLabel(document, "unread");
  if (value === "unread") return hasLabel(document, "unread");
  if (value === "starred") return hasLabel(document, "starred");
  if (value === "important") return hasLabel(document, "important");
  if (value === "muted") return hasLabel(document, "muted");
  return hasLabel(document, value);
}

function matchesHas(value: string, document: SearchDocument): boolean {
  if (value === "attachment") return document.attachmentNames.length > 0;
  if (value === "userlabels") return document.userLabelCount > 0;
  if (value === "nouserlabels") return document.userLabelCount === 0;
  if (value.endsWith("-star")) return hasLabel(document, value);
  if (value === "youtube") return /youtube\.com|youtu\.be/i.test(searchable(document));
  if (["drive", "document"].includes(value)) return /drive\.google\.com|docs\.google\.com/i.test(searchable(document));
  return false;
}

function hasLabel(document: SearchDocument, value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US");
  return document.labels.some((label) => label.toLocaleLowerCase("en-US") === normalized);
}

function searchable(document: SearchDocument): string {
  return [
    document.from,
    ...document.to,
    ...document.cc,
    ...document.bcc,
    document.subject,
    document.text,
    document.html.replace(/<[^>]*>/g, " "),
    ...document.attachmentNames,
  ].join(" ");
}

function matchText(candidate: string, value: string, exact: boolean): boolean {
  const haystack = candidate.toLocaleLowerCase("en-US");
  if (!exact) return haystack.includes(value);
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(value)}(?:$|[^\\p{L}\\p{N}])`, "iu");
  return value.includes(" ") ? haystack.includes(value) : pattern.test(haystack);
}

function matchesAround(text: string, left: string, right: string, distance: number): boolean {
  const words = text.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}@._+-]+/u);
  const leftValue = left.toLocaleLowerCase("en-US");
  const rightValue = right.toLocaleLowerCase("en-US");
  const leftIndexes = words.flatMap((word, index) => (word === leftValue ? [index] : []));
  return leftIndexes.some((index) => words.slice(Math.max(0, index - distance), index + distance + 1).includes(rightValue));
}

function parseDate(value: string): number {
  const normalized = /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(value) ? value.replaceAll("/", "-") : value;
  const date = Date.parse(`${normalized}${/^\d{4}-\d/.test(normalized) ? "T00:00:00Z" : ""}`);
  if (Number.isNaN(date)) throw new Error(`Invalid search date: ${value}`);
  return date;
}

function parseDuration(value: string): number {
  const match = value.match(/^(\d+)([dmy])$/i);
  if (!match) throw new Error(`Invalid search duration: ${value}`);
  const units = { d: 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 } as const;
  return Number(match[1]) * units[match[2]!.toLowerCase() as keyof typeof units];
}

function parseSize(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)([kmg])?$/i);
  if (!match) throw new Error(`Invalid search size: ${value}`);
  const scale = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const;
  return Math.floor(Number(match[1]) * (match[2] ? scale[match[2].toLowerCase() as keyof typeof scale] : 1));
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
        if (query[index] !== '"') throw new Error("Unclosed search quote");
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

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, "").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
