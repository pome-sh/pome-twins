// SPDX-License-Identifier: Apache-2.0
import { invalidArgument } from "./errors.js";
import {
  assertHasOperator,
  CATEGORY_LABELS,
  KNOWN_FIELDS,
  parseDate,
  parseDuration,
  parseSize,
  type SearchDocument,
  type SearchNode,
} from "./search-parse.js";

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
  if (!KNOWN_FIELDS.has(field)) {
    invalidArgument(`Unsupported search operator: ${field}`);
  }
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
  if (field === "category") return matchesCategory(value, document);
  if (field === "in") return matchesFolder(value, document);
  if (field === "is") return matchesStatus(value, document);
  if (field === "has") return matchesHas(value, document);
  invalidArgument(`Unsupported search operator: ${field}`);
}

function matchesCategory(value: string, document: SearchDocument): boolean {
  const mapped = CATEGORY_LABELS[value.toLocaleLowerCase("en-US")];
  if (!mapped) invalidArgument(`Unsupported search category: ${value}`);
  return hasLabel(document, mapped);
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
  const normalized = value.toLocaleLowerCase("en-US");
  assertHasOperator(normalized);
  if (normalized === "attachment") return document.attachmentNames.length > 0;
  if (normalized === "userlabels") return document.userLabelCount > 0;
  if (normalized === "nouserlabels") return document.userLabelCount === 0;
  if (normalized === "youtube") return /youtube\.com|youtu\.be/i.test(searchable(document));
  if (["drive", "document"].includes(normalized)) {
    return /drive\.google\.com|docs\.google\.com/i.test(searchable(document));
  }
  return false;
}

function hasLabel(document: SearchDocument, value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US");
  return document.labels.some((label) => label.toLocaleLowerCase("en-US") === normalized);
}

function searchable(document: SearchDocument): string {
  // Strip tags with a linear scan — avoid backtracking regex on hostile HTML.
  const htmlText = stripHtmlTags(document.html);
  return [
    document.from,
    ...document.to,
    ...document.cc,
    ...document.bcc,
    document.subject,
    document.text,
    htmlText,
    ...document.attachmentNames,
  ].join(" ");
}

/** Linear HTML tag strip — safe for untrusted MIME (no ReDoS). */
export function stripHtmlTags(value: string): string {
  let out = "";
  let inTag = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "<") {
      inTag = true;
      continue;
    }
    if (char === ">" && inTag) {
      inTag = false;
      out += " ";
      continue;
    }
    if (!inTag) out += char;
  }
  return out;
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

function normalizeMessageId(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("<")) normalized = normalized.slice(1);
  if (normalized.endsWith(">")) normalized = normalized.slice(0, -1);
  return normalized.toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
