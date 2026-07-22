// SPDX-License-Identifier: Apache-2.0
import { invalidArgument, notFound, unsupported } from "../errors.js";
import { matchesSearch } from "../search-match.js";
import { parseSearchQuery, validateSearchQuery } from "../search-parse.js";
import { addHistory, assertLabels, nextId, semanticMessage } from "../storage.js";
import type { GmailTwinDatabase, SeedFilter } from "../types.js";
import { searchDocument, searchNow } from "./hydrate.js";
import type { GmailDomain } from "./gmail-domain.js";

export type FilterResource = Required<Pick<SeedFilter, "criteria" | "action">> & { id: string };

export function applyInboundFilters(db: GmailTwinDatabase, mailboxId: number, messageId: string): void {
  const filters = db
    .prepare("SELECT criteria_json, action_json FROM filters WHERE mailbox_id = ? ORDER BY id")
    .all(mailboxId) as Array<{ criteria_json: string; action_json: string }>;
  for (const row of filters) {
    const criteria = JSON.parse(row.criteria_json) as Record<string, unknown>;
    const action = JSON.parse(row.action_json) as {
      addLabelIds?: string[];
      removeLabelIds?: string[];
      forward?: string;
    };
    if (action.forward) unsupported("Filter forwarding is not implemented");
    const message = semanticMessage(db, mailboxId, messageId);
    const document = searchDocument(db, mailboxId, message);
    const criteriaTo = typeof criteria.to === "string" ? criteria.to.toLowerCase() : undefined;
    const now = searchNow(db);
    const matches =
      (typeof criteria.from !== "string" || document.from.includes(criteria.from.toLowerCase())) &&
      (criteriaTo === undefined || document.to.some((to) => to.includes(criteriaTo))) &&
      (typeof criteria.subject !== "string" ||
        document.subject.toLowerCase().includes(criteria.subject.toLowerCase())) &&
      (criteria.hasAttachment !== true || document.attachmentNames.length > 0) &&
      (typeof criteria.size !== "number" ||
        (criteria.sizeComparison === "smaller" ? document.size < criteria.size : document.size > criteria.size)) &&
      (typeof criteria.query !== "string" || matchesSearch(parseSearchQuery(criteria.query), document, now)) &&
      (typeof criteria.negatedQuery !== "string" ||
        !matchesSearch(parseSearchQuery(criteria.negatedQuery), document, now));
    if (!matches) continue;
    assertLabels(db, mailboxId, [...(action.addLabelIds ?? []), ...(action.removeLabelIds ?? [])]);
    const beforeLabels = new Set(message.labelIds);
    const removed: string[] = [];
    const added: string[] = [];
    for (const label of action.removeLabelIds ?? []) {
      const result = db
        .prepare("DELETE FROM message_labels WHERE mailbox_id = ? AND message_id = ? AND label_id = ?")
        .run(mailboxId, messageId, label);
      if (result.changes > 0 && beforeLabels.has(label)) removed.push(label);
    }
    for (const label of action.addLabelIds ?? []) {
      const result = db
        .prepare("INSERT OR IGNORE INTO message_labels(mailbox_id, message_id, label_id) VALUES (?, ?, ?)")
        .run(mailboxId, messageId, label);
      if (result.changes > 0 && !beforeLabels.has(label)) added.push(label);
    }
    if (added.length) addHistory(db, mailboxId, messageId, message.threadId, "labelAdded", added);
    if (removed.length) addHistory(db, mailboxId, messageId, message.threadId, "labelRemoved", removed);
  }
}

export function filters(domain: GmailDomain, email: string): FilterResource[] {
  const mailboxId = domain.mailboxId(email);
  const rows = domain.db
    .prepare("SELECT id, criteria_json, action_json FROM filters WHERE mailbox_id = ? ORDER BY id")
    .all(mailboxId) as Array<{ id: string; criteria_json: string; action_json: string }>;
  return rows.map(toFilter);
}

export function filter(domain: GmailDomain, email: string, filterId: string): FilterResource {
  const mailboxId = domain.mailboxId(email);
  const row = domain.db
    .prepare("SELECT id, criteria_json, action_json FROM filters WHERE mailbox_id = ? AND id = ?")
    .get(mailboxId, filterId) as { id: string; criteria_json: string; action_json: string } | undefined;
  if (!row) notFound("Filter");
  return toFilter(row);
}

export function createFilter(
  domain: GmailDomain,
  email: string,
  criteria: SeedFilter["criteria"] = {},
  action: SeedFilter["action"] = {}
): FilterResource {
  if (action.forward) unsupported("Filter action.forward is not supported by the Gmail twin");
  const mailboxId = domain.mailboxId(email);
  const count = domain.db.prepare("SELECT COUNT(*) AS count FROM filters WHERE mailbox_id = ?").get(mailboxId) as {
    count: number;
  };
  if (count.count >= 1000) invalidArgument("Filter limit exceeded");
  assertLabels(domain.db, mailboxId, [...(action.addLabelIds ?? []), ...(action.removeLabelIds ?? [])]);
  if (criteria.query) validateSearchQuery(criteria.query);
  if (criteria.negatedQuery) validateSearchQuery(criteria.negatedQuery);
  const id = nextId(domain.db, mailboxId, "filter_counter", "filter");
  domain.db
    .prepare("INSERT INTO filters(mailbox_id, id, criteria_json, action_json) VALUES (?, ?, ?, ?)")
    .run(mailboxId, id, JSON.stringify(criteria), JSON.stringify(action));
  return { id, criteria, action };
}

export function deleteFilter(domain: GmailDomain, email: string, filterId: string): void {
  const mailboxId = domain.mailboxId(email);
  const result = domain.db
    .prepare("DELETE FROM filters WHERE mailbox_id = ? AND id = ?")
    .run(mailboxId, filterId);
  if (result.changes === 0) notFound("Filter");
}

function toFilter(row: { id: string; criteria_json: string; action_json: string }): FilterResource {
  return {
    id: row.id,
    criteria: JSON.parse(row.criteria_json) as NonNullable<SeedFilter["criteria"]>,
    action: JSON.parse(row.action_json) as NonNullable<SeedFilter["action"]>,
  };
}
