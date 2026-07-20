// SPDX-License-Identifier: Apache-2.0
import type { GmailTwinDatabase } from "./types.js";

export type GmailStateExport = {
  schemaVersion: 1;
  deliveryMode: string;
  mailboxes: unknown[];
  counters: unknown[];
  threads: unknown[];
  messages: unknown[];
  drafts: unknown[];
  labels: unknown[];
  messageLabels: unknown[];
  attachments: unknown[];
  history: unknown[];
  filters: unknown[];
  forwardingAddresses: unknown[];
  sendAs: unknown[];
};

/** Bounded, redacted entity collections used on recorder `state_delta`. */
export type GmailStateDeltaView = {
  schemaVersion: 1;
  deliveryMode?: string;
  mailboxes?: unknown[];
  counters?: unknown[];
  threads?: unknown[];
  messages?: unknown[];
  drafts?: unknown[];
  labels?: unknown[];
  messageLabels?: unknown[];
  attachments?: unknown[];
  history?: unknown[];
  filters?: unknown[];
  forwardingAddresses?: unknown[];
  sendAs?: unknown[];
};

const ENTITY_COLLECTIONS = [
  "mailboxes",
  "counters",
  "threads",
  "messages",
  "drafts",
  "labels",
  "messageLabels",
  "attachments",
  "history",
  "filters",
  "forwardingAddresses",
  "sendAs",
] as const;

type EntityCollection = (typeof ENTITY_COLLECTIONS)[number];

export function exportGmailState(db: GmailTwinDatabase): GmailStateExport {
  const delivery = db.prepare("SELECT value FROM gmail_config WHERE key = 'delivery_mode'").get() as
    | { value: string }
    | undefined;
  return {
    schemaVersion: 1,
    deliveryMode: delivery?.value ?? "sender-only",
    mailboxes: rows(
      db,
      `SELECT email, display_name AS displayName, created_at AS createdAt
       FROM mailboxes ORDER BY email COLLATE NOCASE`
    ),
    counters: rows(
      db,
      `SELECT m.email AS mailboxEmail, c.message_counter AS messageCounter,
        c.thread_counter AS threadCounter, c.draft_counter AS draftCounter,
        c.label_counter AS labelCounter, c.attachment_counter AS attachmentCounter,
        c.history_counter AS historyCounter, c.filter_counter AS filterCounter,
        c.logical_clock AS logicalClock
       FROM mailbox_counters c JOIN mailboxes m ON m.id = c.mailbox_id
       ORDER BY m.email COLLATE NOCASE`
    ),
    threads: rows(
      db,
      `SELECT mb.email AS mailboxEmail, t.id, t.created_at AS createdAt, t.updated_at AS updatedAt
       FROM threads t JOIN mailboxes mb ON mb.id = t.mailbox_id
       ORDER BY mb.email COLLATE NOCASE, t.id`
    ),
    messages: rows(
      db,
      `SELECT mb.email AS mailboxEmail, m.id, m.thread_id AS threadId,
        m.rfc_message_id AS rfcMessageId, m.internal_date AS internalDate,
        m.sent_at AS sentAt, m.from_address AS "from", m.to_json AS "to",
        m.cc_json AS cc, m.bcc_json AS bcc, m.delivered_to AS deliveredTo,
        m.subject, m.snippet, m.text_body AS text, m.html_body AS html,
        m.headers_json AS headers, m.size_estimate AS sizeEstimate,
        b.sha256 AS rawSha256, b.size AS rawSize
       FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
       JOIN message_blobs b ON b.mailbox_id = m.mailbox_id AND b.message_id = m.id
       ORDER BY mb.email COLLATE NOCASE, m.internal_date, m.id`,
      ["to", "cc", "bcc", "headers"]
    ),
    drafts: rows(
      db,
      `SELECT mb.email AS mailboxEmail, d.id, d.message_id AS messageId,
        d.created_at AS createdAt, d.updated_at AS updatedAt
       FROM drafts d JOIN mailboxes mb ON mb.id = d.mailbox_id
       ORDER BY mb.email COLLATE NOCASE, d.id`
    ),
    labels: rows(
      db,
      `SELECT mb.email AS mailboxEmail, l.id, l.name, l.type,
        l.text_color AS textColor, l.background_color AS backgroundColor
       FROM labels l JOIN mailboxes mb ON mb.id = l.mailbox_id
       ORDER BY mb.email COLLATE NOCASE, l.id`
    ),
    messageLabels: rows(
      db,
      `SELECT mb.email AS mailboxEmail, ml.message_id AS messageId, ml.label_id AS labelId
       FROM message_labels ml JOIN mailboxes mb ON mb.id = ml.mailbox_id
       ORDER BY mb.email COLLATE NOCASE, ml.message_id, ml.label_id`
    ),
    attachments: rows(
      db,
      `SELECT mb.email AS mailboxEmail, a.message_id AS messageId, a.id,
        a.part_index AS partIndex, a.filename, a.mime_type AS mimeType,
        a.disposition, a.content_id AS contentId, a.sha256, a.size
       FROM attachments a JOIN mailboxes mb ON mb.id = a.mailbox_id
       ORDER BY mb.email COLLATE NOCASE, a.message_id, a.part_index`
    ),
    history: rows(
      db,
      `SELECT mb.email AS mailboxEmail, CAST(h.id AS TEXT) AS id,
        h.message_id AS messageId, h.thread_id AS threadId, h.event_type AS type,
        h.label_ids_json AS labelIds, h.created_at AS timestamp
       FROM history h JOIN mailboxes mb ON mb.id = h.mailbox_id
       ORDER BY mb.email COLLATE NOCASE, h.id`,
      ["labelIds"]
    ),
    filters: rows(
      db,
      `SELECT mb.email AS mailboxEmail, f.id, f.criteria_json AS criteria, f.action_json AS action
       FROM filters f JOIN mailboxes mb ON mb.id = f.mailbox_id
       ORDER BY mb.email COLLATE NOCASE, f.id`,
      ["criteria", "action"]
    ),
    forwardingAddresses: rows(
      db,
      `SELECT mb.email AS mailboxEmail, f.email, f.verification_status AS verificationStatus
       FROM forwarding_addresses f JOIN mailboxes mb ON mb.id = f.mailbox_id
       ORDER BY mb.email COLLATE NOCASE, f.email COLLATE NOCASE`
    ),
    sendAs: rows(
      db,
      `SELECT mb.email AS mailboxEmail, s.email, s.display_name AS displayName,
        s.reply_to_address AS replyToAddress, s.is_primary AS isPrimary,
        s.is_default AS isDefault, s.verification_status AS verificationStatus
       FROM send_as s JOIN mailboxes mb ON mb.id = s.mailbox_id
       ORDER BY mb.email COLLATE NOCASE, s.email COLLATE NOCASE`
    ),
  };
}

/**
 * Build a bounded `state_delta` with only changed entities.
 * Message summaries omit plaintext text/html/raw/MIME bodies.
 */
export function gmailStateDelta(
  before: GmailStateExport,
  after: GmailStateExport
): { before: GmailStateDeltaView | null; after: GmailStateDeltaView | null } | null {
  const beforeView: GmailStateDeltaView = { schemaVersion: 1 };
  const afterView: GmailStateDeltaView = { schemaVersion: 1 };
  let changed = false;

  if (before.deliveryMode !== after.deliveryMode) {
    beforeView.deliveryMode = before.deliveryMode;
    afterView.deliveryMode = after.deliveryMode;
    changed = true;
  }

  for (const collection of ENTITY_COLLECTIONS) {
    const beforeMap = indexEntities(before[collection] as unknown[], collection);
    const afterMap = indexEntities(after[collection] as unknown[], collection);
    const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    const beforeChanged: unknown[] = [];
    const afterChanged: unknown[] = [];
    for (const key of [...keys].sort()) {
      const left = beforeMap.get(key);
      const right = afterMap.get(key);
      if (stableStringify(left) === stableStringify(right)) continue;
      if (left !== undefined) beforeChanged.push(summarizeEntity(collection, left));
      if (right !== undefined) afterChanged.push(summarizeEntity(collection, right));
    }
    if (beforeChanged.length || afterChanged.length) {
      beforeView[collection] = beforeChanged;
      afterView[collection] = afterChanged;
      changed = true;
    }
  }

  // Parent null = no mutation (SDK/shared-types contract). Never emit
  // `{ before: null, after: null }` for identical before/after exports.
  if (!changed) return null;
  return { before: beforeView, after: afterView };
}

function indexEntities(items: unknown[], collection: EntityCollection): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    map.set(entityKey(collection, row), row);
  }
  return map;
}

function entityKey(collection: EntityCollection, row: Record<string, unknown>): string {
  const mailbox = String(row.mailboxEmail ?? row.email ?? "");
  switch (collection) {
    case "mailboxes":
      return String(row.email ?? "").toLowerCase();
    case "counters":
      return mailbox.toLowerCase();
    case "messageLabels":
      return `${mailbox.toLowerCase()}:${row.messageId}:${row.labelId}`;
    case "attachments":
      return `${mailbox.toLowerCase()}:${row.messageId}:${row.id}`;
    case "forwardingAddresses":
    case "sendAs":
      return `${mailbox.toLowerCase()}:${String(row.email ?? "").toLowerCase()}`;
    default:
      return `${mailbox.toLowerCase()}:${row.id}`;
  }
}

function summarizeEntity(collection: EntityCollection, row: Record<string, unknown>): Record<string, unknown> {
  if (collection !== "messages") return { ...row };
  // Bounded semantic summary — never include plaintext bodies, snippets, or MIME.
  const {
    text: _text,
    html: _html,
    headers: _headers,
    snippet: _snippet,
    ...rest
  } = row;
  return {
    ...rest,
    bodyOmitted: true,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function rows(db: GmailTwinDatabase, sql: string, jsonColumns: string[] = []): unknown[] {
  return db.prepare(sql).all().map((input) => {
    const row = { ...(input as Record<string, unknown>) };
    for (const column of jsonColumns) {
      if (typeof row[column] === "string") row[column] = JSON.parse(row[column]);
    }
    if ("isPrimary" in row) row.isPrimary = Boolean(row.isPrimary);
    if ("isDefault" in row) row.isDefault = Boolean(row.isDefault);
    return row;
  });
}
