// file-size: GmailDomain is the single coordinator for mailbox/message/draft/history ops — splitting would scatter cross-table transactions and history recording across modules.
// SPDX-License-Identifier: Apache-2.0
import { invalidArgument, notFound } from "./errors.js";
import { canonicalRaw, composeMime, decodeGmailRaw, parseMime, stripBcc } from "./mime.js";
import { validateSearchQuery, matchesSearch, SEARCH_MAILBOX_MESSAGE_BUDGET } from "./search.js";
import { defaultSeedState, parseSeed, type ParsedGmailStateSeed } from "./seed.js";
import {
  addHistory,
  assertLabels,
  insertStoredMessage,
  nextId,
  nextTimestamp,
  rawMessage,
  semanticMessage,
} from "./storage.js";
import type {
  DeliveryMode,
  DraftRow,
  GmailStateSeed,
  GmailTwinDatabase,
  HistoryEvent,
  SeedAttachment,
  SemanticMessage,
} from "./types.js";
import { resetDatabase } from "./db.js";
import { exportGmailState, type GmailStateExport } from "./state.js";
import { seedMailbox } from "./seeding.js";
import { applyInboundFilters, searchDocument, searchNow } from "./domain-search.js";

export class GmailDomain {
  constructor(readonly db: GmailTwinDatabase) {}

  seed(input: GmailStateSeed | ParsedGmailStateSeed): void {
    const seed = parseSeed(input);
    this.db.transaction(() => {
      resetDatabase(this.db);
      this.db.prepare("INSERT INTO gmail_config(key, value) VALUES ('clock', ?)").run(seed.clock);
      this.db.prepare("INSERT INTO gmail_config(key, value) VALUES ('delivery_mode', ?)").run(seed.deliveryMode);
      for (const mailbox of [seed.primaryMailbox, ...seed.mailboxes]) seedMailbox(this.db, mailbox);
    }).immediate();
  }

  applySeed(input: unknown): { ok: true } {
    this.seed(parseSeed(input));
    return { ok: true };
  }

  resetToDefault(): { ok: true } {
    this.seed(defaultSeedState());
    return { ok: true };
  }

  mailboxId(email: string): number {
    const row = this.db
      .prepare("SELECT id FROM mailboxes WHERE email = ? COLLATE NOCASE")
      .get(email) as { id: number } | undefined;
    if (!row) notFound("User");
    return row.id;
  }

  getRaw(email: string, messageId: string): Buffer {
    return rawMessage(this.db, this.mailboxId(email), messageId);
  }

  getMessage(email: string, messageId: string): SemanticMessage {
    return semanticMessage(this.db, this.mailboxId(email), messageId);
  }

  getThread(email: string, threadId: string): {
    id: string;
    labelIds: string[];
    messages: SemanticMessage[];
  } {
    const mailboxId = this.mailboxId(email);
    const rows = this.db
      .prepare(
        "SELECT id FROM messages WHERE mailbox_id = ? AND thread_id = ? ORDER BY internal_date, id"
      )
      .all(mailboxId, threadId) as Array<{ id: string }>;
    if (!rows.length) notFound("Thread");
    const messages = rows.map((row) => semanticMessage(this.db, mailboxId, row.id));
    return {
      id: threadId,
      labelIds: [...new Set(messages.flatMap((message) => message.labelIds))].sort(),
      messages,
    };
  }

  insertMessage(
    email: string,
    raw: Uint8Array | string,
    options: { threadId?: string; labels?: string[]; incoming?: boolean } = {}
  ): SemanticMessage {
    const mailboxId = this.mailboxId(email);
    const bytes = acceptedRaw(raw);
    return this.db.transaction(() => {
      const message = insertStoredMessage(this.db, mailboxId, bytes, {
        threadId: options.threadId,
        labels: options.labels ?? (options.incoming ? ["INBOX"] : []),
        deliveredTo: options.incoming ? email : undefined,
      });
      if (options.incoming) applyInboundFilters(this.db, mailboxId, message.id);
      return semanticMessage(this.db, mailboxId, message.id);
    }).immediate();
  }

  sendMessage(
    email: string,
    raw: Uint8Array | string,
    options: { threadId?: string } = {}
  ): { sender: SemanticMessage; deliveries: Array<{ mailboxEmail: string; message: SemanticMessage }> } {
    const senderMailboxId = this.mailboxId(email);
    const bytes = acceptedRaw(raw);
    const parsed = parseMime(bytes);
    this.assertAcceptedFrom(senderMailboxId, parsed.from);
    return this.db.transaction(() => {
      const recipientEmails = [...new Set([...parsed.to, ...parsed.cc, ...parsed.bcc].map((item) => item.toLowerCase()))];
      const selfDelivery = this.deliveryMode() === "seeded-mailboxes" && recipientEmails.includes(email.toLowerCase());
      const sender = insertStoredMessage(this.db, senderMailboxId, bytes, {
        threadId: options.threadId,
        labels: selfDelivery ? ["INBOX", "SENT"] : ["SENT"],
      });
      if (selfDelivery) applyInboundFilters(this.db, senderMailboxId, sender.id);
      const deliveries: Array<{ mailboxEmail: string; message: SemanticMessage }> = [];
      if (this.deliveryMode() === "seeded-mailboxes") {
        const visibleRaw = stripBcc(bytes);
        for (const recipient of recipientEmails) {
          if (recipient === email.toLowerCase()) continue;
          const mailbox = this.db
            .prepare("SELECT id, email FROM mailboxes WHERE email = ? COLLATE NOCASE")
            .get(recipient) as { id: number; email: string } | undefined;
          if (!mailbox) continue;
          const copy = insertStoredMessage(this.db, mailbox.id, visibleRaw, {
            labels: ["INBOX"],
            deliveredTo: mailbox.email,
          });
          applyInboundFilters(this.db, mailbox.id, copy.id);
          deliveries.push({ mailboxEmail: mailbox.email, message: semanticMessage(this.db, mailbox.id, copy.id) });
        }
      }
      return { sender: semanticMessage(this.db, senderMailboxId, sender.id), deliveries };
    }).immediate();
  }

  createDraft(email: string, raw: Uint8Array | string, options: { threadId?: string } = {}): {
    id: string;
    message: SemanticMessage;
  } {
    const mailboxId = this.mailboxId(email);
    const bytes = acceptedRaw(raw);
    return this.db.transaction(() => {
      const message = insertStoredMessage(this.db, mailboxId, bytes, {
        threadId: options.threadId,
        draft: true,
      });
      const draftId = nextId(this.db, mailboxId, "draft_counter", "draft");
      const now = nextTimestamp(this.db, mailboxId);
      this.db
        .prepare("INSERT INTO drafts(mailbox_id, id, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(mailboxId, draftId, message.id, now, now);
      addHistory(this.db, mailboxId, message.id, message.threadId, "draftCreated", ["DRAFT"]);
      return { id: draftId, message };
    }).immediate();
  }

  createComposedDraft(
    email: string,
    input: {
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      text?: string;
      html?: string;
      replyToMessageId?: string;
      attachments?: SeedAttachment[];
    }
  ): { id: string; message: SemanticMessage } {
    const mailboxId = this.mailboxId(email);
    return this.db.transaction(() => {
      const reply = input.replyToMessageId
        ? semanticMessage(this.db, mailboxId, input.replyToMessageId)
        : undefined;
      const raw = composeMime({
        from: email,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject ?? (reply ? `Re: ${reply.subject}` : ""),
        text: reply ? [input.text ?? "", reply.text].filter(Boolean).join("\r\n\r\n") : input.text,
        html: reply ? [input.html ?? "", reply.html].filter(Boolean).join("<br><br>") : input.html,
        date: nextTimestamp(this.db, mailboxId),
        messageId: `${nextId(this.db, mailboxId, "message_counter", "rfc")}@pome-twin.test`,
        inReplyTo: reply?.rfcMessageId,
        references: reply ? [reply.rfcMessageId] : undefined,
        attachments: input.attachments,
      });
      return this.createDraft(email, raw, { threadId: reply?.threadId });
    }).immediate();
  }

  listDrafts(email: string, query = ""): Array<{ id: string; message: SemanticMessage }> {
    const mailboxId = this.mailboxId(email);
    const rows = this.db
      .prepare(
        `SELECT d.id, d.message_id
         FROM drafts d JOIN messages m ON m.mailbox_id = d.mailbox_id AND m.id = d.message_id
         WHERE d.mailbox_id = ? ORDER BY d.updated_at DESC, d.id DESC`
      )
      .all(mailboxId) as Array<{ id: string; message_id: string }>;
    const matchingIds = query
      ? new Set(
          this.searchMessages(email, `in:draft ${query}`, { includeTrash: true }).map(
            (message) => message.id
          )
        )
      : undefined;
    return rows
      .filter((row) => matchingIds?.has(row.message_id) ?? true)
      .map((row) => ({ id: row.id, message: semanticMessage(this.db, mailboxId, row.message_id) }));
  }

  updateDraft(email: string, draftId: string, raw: Uint8Array | string, options: { threadId?: string } = {}): {
    id: string;
    message: SemanticMessage;
  } {
    const mailboxId = this.mailboxId(email);
    const bytes = acceptedRaw(raw);
    return this.db.transaction(() => {
      const draft = this.requireDraft(mailboxId, draftId);
      const old = semanticMessage(this.db, mailboxId, draft.message_id);
      const replacement = insertStoredMessage(this.db, mailboxId, bytes, {
        threadId: options.threadId,
        draft: true,
      });
      const now = nextTimestamp(this.db, mailboxId);
      this.db
        .prepare("UPDATE drafts SET message_id = ?, updated_at = ? WHERE mailbox_id = ? AND id = ?")
        .run(replacement.id, now, mailboxId, draftId);
      this.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, draft.message_id);
      this.removeEmptyThread(mailboxId, old.threadId);
      addHistory(this.db, mailboxId, draft.message_id, old.threadId, "draftReplaced");
      return { id: draftId, message: replacement };
    }).immediate();
  }

  sendDraft(email: string, draftId: string): ReturnType<GmailDomain["sendMessage"]> {
    const mailboxId = this.mailboxId(email);
    return this.db.transaction(() => {
      const draft = this.requireDraft(mailboxId, draftId);
      const raw = rawMessage(this.db, mailboxId, draft.message_id);
      const old = semanticMessage(this.db, mailboxId, draft.message_id);
      this.db.prepare("DELETE FROM drafts WHERE mailbox_id = ? AND id = ?").run(mailboxId, draftId);
      this.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, draft.message_id);
      // Keep the draft's thread row even when it becomes empty — send reuses
      // old.threadId (Gmail draft send identity). removeEmptyThread here would
      // drop solo-draft threads and force a new thread id on send.
      addHistory(this.db, mailboxId, draft.message_id, old.threadId, "draftSent");
      return this.sendMessage(email, raw, { threadId: old.threadId });
    }).immediate();
  }

  deleteDraft(email: string, draftId: string): void {
    const mailboxId = this.mailboxId(email);
    this.db.transaction(() => {
      const draft = this.requireDraft(mailboxId, draftId);
      const message = semanticMessage(this.db, mailboxId, draft.message_id);
      this.db.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?").run(mailboxId, draft.message_id);
      this.removeEmptyThread(mailboxId, message.threadId);
      addHistory(this.db, mailboxId, draft.message_id, message.threadId, "draftDeleted");
    }).immediate();
  }

  modifyMessageLabels(email: string, messageId: string, add: string[] = [], remove: string[] = []): SemanticMessage {
    const mailboxId = this.mailboxId(email);
    return this.db.transaction(() => {
      const before = semanticMessage(this.db, mailboxId, messageId);
      if (before.labelIds.includes("DRAFT") && (add.some((id) => id !== "DRAFT") || remove.includes("DRAFT"))) {
        invalidArgument("Draft messages may only carry the DRAFT label");
      }
      if (!before.labelIds.includes("DRAFT") && add.includes("DRAFT")) {
        invalidArgument("The DRAFT label is managed by draft operations");
      }
      assertLabels(this.db, mailboxId, [...add, ...remove]);
      const actualRemove = [...new Set(remove)].filter((label) => before.labelIds.includes(label));
      const actualAdd = [...new Set(add)].filter((label) => !before.labelIds.includes(label));
      for (const label of actualRemove) {
        this.db
          .prepare("DELETE FROM message_labels WHERE mailbox_id = ? AND message_id = ? AND label_id = ?")
          .run(mailboxId, messageId, label);
      }
      for (const label of actualAdd) {
        this.db
          .prepare("INSERT OR IGNORE INTO message_labels(mailbox_id, message_id, label_id) VALUES (?, ?, ?)")
          .run(mailboxId, messageId, label);
      }
      if (actualAdd.length) addHistory(this.db, mailboxId, messageId, before.threadId, "labelAdded", actualAdd);
      if (actualRemove.length) addHistory(this.db, mailboxId, messageId, before.threadId, "labelRemoved", actualRemove);
      return semanticMessage(this.db, mailboxId, messageId);
    }).immediate();
  }

  modifyThreadLabels(email: string, threadId: string, add: string[] = [], remove: string[] = []): {
    id: string;
    labelIds: string[];
    messages: SemanticMessage[];
  } {
    return this.db.transaction(() => {
      const thread = this.getThread(email, threadId);
      for (const message of thread.messages) this.modifyMessageLabels(email, message.id, add, remove);
      return this.getThread(email, threadId);
    }).immediate();
  }

  createLabel(email: string, name: string, color?: { textColor?: string; backgroundColor?: string }): {
    id: string;
    name: string;
  } {
    const mailboxId = this.mailboxId(email);
    if (!name.trim()) invalidArgument("Label name is required");
    return this.db.transaction(() => {
      const id = nextId(this.db, mailboxId, "label_counter", "Label");
      try {
        this.db
          .prepare(
            "INSERT INTO labels(mailbox_id, id, name, type, text_color, background_color) VALUES (?, ?, ?, 'user', ?, ?)"
          )
          .run(mailboxId, id, name.trim(), color?.textColor ?? null, color?.backgroundColor ?? null);
      } catch {
        invalidArgument(`Label already exists: ${name}`);
      }
      return { id, name: name.trim() };
    }).immediate();
  }

  listUserLabels(email: string): Array<{
    id: string;
    name: string;
    color?: { textColor?: string; backgroundColor?: string };
    threadsTotal: number;
    threadsUnread: number;
  }> {
    const mailboxId = this.mailboxId(email);
    const rows = this.db
      .prepare(
        `SELECT l.id, l.name, l.text_color, l.background_color,
          COUNT(DISTINCT m.thread_id) AS threads_total,
          COUNT(DISTINCT CASE WHEN unread.message_id IS NOT NULL THEN m.thread_id END) AS threads_unread
         FROM labels l
         LEFT JOIN message_labels ml
           ON ml.mailbox_id = l.mailbox_id AND ml.label_id = l.id
         LEFT JOIN messages m
           ON m.mailbox_id = ml.mailbox_id AND m.id = ml.message_id
         LEFT JOIN message_labels unread
           ON unread.mailbox_id = m.mailbox_id
          AND unread.message_id = m.id
          AND unread.label_id = 'UNREAD'
         WHERE l.mailbox_id = ? AND l.type = 'user'
         GROUP BY l.mailbox_id, l.id
         ORDER BY l.name COLLATE NOCASE, l.id`
      )
      .all(mailboxId) as Array<{
      id: string;
      name: string;
      text_color: string | null;
      background_color: string | null;
      threads_total: number;
      threads_unread: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.text_color || row.background_color
        ? {
            color: {
              ...(row.text_color ? { textColor: row.text_color } : {}),
              ...(row.background_color ? { backgroundColor: row.background_color } : {}),
            },
          }
        : {}),
      threadsTotal: row.threads_total,
      threadsUnread: row.threads_unread,
    }));
  }

  listHistory(email: string, startHistoryId: string, options: { types?: string[] } = {}): {
    history: HistoryEvent[];
    historyId: string;
  } {
    const mailboxId = this.mailboxId(email);
    const start = Number(startHistoryId);
    if (!Number.isSafeInteger(start) || start < 0) invalidArgument("Invalid startHistoryId");
    const current = this.currentHistoryId(mailboxId);
    if (start > current) notFound("History");
    const rows = this.db
      .prepare(
        `SELECT h.*, m.email AS mailbox_email
         FROM history h JOIN mailboxes m ON m.id = h.mailbox_id
         WHERE h.mailbox_id = ? AND h.id > ? ORDER BY h.id`
      )
      .all(mailboxId, start) as Array<{
      id: number;
      mailbox_email: string;
      message_id: string | null;
      thread_id: string | null;
      event_type: string;
      label_ids_json: string;
      created_at: string;
    }>;
    return {
      history: rows
        .filter((row) => !options.types?.length || options.types.includes(row.event_type))
        .map((row) => ({
          id: String(row.id),
          mailboxEmail: row.mailbox_email,
          messageId: row.message_id,
          threadId: row.thread_id,
          type: row.event_type,
          labelIds: JSON.parse(row.label_ids_json) as string[],
          timestamp: row.created_at,
        })),
      historyId: String(current),
    };
  }

  searchMessages(email: string, query = "", options: { includeTrash?: boolean } = {}): SemanticMessage[] {
    const mailboxId = this.mailboxId(email);
    const ast = validateSearchQuery(query);
    const messageCount = (
      this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?").get(mailboxId) as {
        count: number;
      }
    ).count;
    // Intentional in-memory bound: hydrate + JS predicate. Fail loud before OOM.
    // SQL compile of the AST (`compileSearchToSql`) is deferred until budgets land in prod paths.
    if (messageCount > SEARCH_MAILBOX_MESSAGE_BUDGET) {
      invalidArgument(
        `Mailbox exceeds in-memory search budget (${SEARCH_MAILBOX_MESSAGE_BUDGET} messages); reduce mailbox size or wait for SQL-backed search`
      );
    }
    const rows = this.db
      .prepare("SELECT id FROM messages WHERE mailbox_id = ? ORDER BY internal_date DESC, id DESC")
      .all(mailboxId) as Array<{ id: string }>;
    const explicitAnywhere = /\bin:(anywhere|trash|spam|draft)\b/i.test(query);
    return rows
      .map((row) => semanticMessage(this.db, mailboxId, row.id))
      .filter((message) => {
        if (!explicitAnywhere && !options.includeTrash && message.labelIds.some((id) => ["TRASH", "SPAM", "DRAFT"].includes(id))) {
          return false;
        }
        return matchesSearch(ast, searchDocument(this.db, mailboxId, message), searchNow(this.db));
      });
  }

  searchThreads(email: string, query = "", options: { includeTrash?: boolean } = {}): ReturnType<GmailDomain["getThread"]>[] {
    const matches = this.searchMessages(email, query, options);
    return [...new Set(matches.map((message) => message.threadId))].map((threadId) => this.getThread(email, threadId));
  }

  exportState(): GmailStateExport {
    return exportGmailState(this.db);
  }

  /** Snapshot high-water for opaque page tokens (mailbox history counter). */
  currentHistoryIdFor(email: string): string {
    return String(this.currentHistoryId(this.mailboxId(email)));
  }

  private requireDraft(mailboxId: number, draftId: string): DraftRow {
    const row = this.db
      .prepare("SELECT * FROM drafts WHERE mailbox_id = ? AND id = ?")
      .get(mailboxId, draftId) as DraftRow | undefined;
    if (!row) notFound("Draft");
    return row;
  }

  private removeEmptyThread(mailboxId: number, threadId: string): void {
    const member = this.db
      .prepare("SELECT 1 FROM messages WHERE mailbox_id = ? AND thread_id = ? LIMIT 1")
      .get(mailboxId, threadId);
    if (!member) this.db.prepare("DELETE FROM threads WHERE mailbox_id = ? AND id = ?").run(mailboxId, threadId);
  }

  private currentHistoryId(mailboxId: number): number {
    const row = this.db
      .prepare("SELECT history_counter FROM mailbox_counters WHERE mailbox_id = ?")
      .get(mailboxId) as { history_counter: number };
    return row.history_counter;
  }

  private deliveryMode(): DeliveryMode {
    const row = this.db
      .prepare("SELECT value FROM gmail_config WHERE key = 'delivery_mode'")
      .get() as { value: DeliveryMode };
    return row.value;
  }

  private assertAcceptedFrom(mailboxId: number, from: string): void {
    if (!from) invalidArgument("From header is required");
    const accepted = this.db
      .prepare(
        `SELECT 1 FROM send_as
         WHERE mailbox_id = ? AND email = ? COLLATE NOCASE AND verification_status = 'accepted'`
      )
      .get(mailboxId, from);
    if (!accepted) invalidArgument("From address is not an accepted send-as identity");
  }

}

function acceptedRaw(raw: Uint8Array | string): Buffer {
  return typeof raw === "string"
    ? raw.includes("\n")
      ? canonicalRaw(raw)
      : decodeGmailRaw(raw)
    : canonicalRaw(raw);
}
