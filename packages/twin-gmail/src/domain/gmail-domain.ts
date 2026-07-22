// SPDX-License-Identifier: Apache-2.0
import { notFound } from "../errors.js";
import { defaultSeedState, parseSeed, type ParsedGmailStateSeed } from "../seed.js";
import { resetDatabase } from "../db.js";
import { exportGmailState, type GmailStateExport } from "../state.js";
import { seedMailbox } from "../seeding.js";
import type { GmailStateSeed, GmailTwinDatabase, HistoryEvent, SeedAttachment, SeedFilter, SemanticMessage } from "../types.js";
import * as drafts from "./drafts.js";
import * as filters from "./filters.js";
import * as labels from "./labels.js";
import * as messages from "./messages.js";
import * as settings from "./settings.js";

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
    return messages.getRaw(this, email, messageId);
  }

  getMessage(email: string, messageId: string): SemanticMessage {
    return messages.getMessage(this, email, messageId);
  }

  getThread(email: string, threadId: string): ReturnType<typeof messages.getThread> {
    return messages.getThread(this, email, threadId);
  }

  insertMessage(
    email: string,
    raw: Uint8Array | string,
    options: { threadId?: string; labels?: string[]; incoming?: boolean } = {}
  ): SemanticMessage {
    return messages.insertMessage(this, email, raw, options);
  }

  sendMessage(
    email: string,
    raw: Uint8Array | string,
    options: { threadId?: string } = {}
  ): ReturnType<typeof messages.sendMessage> {
    return messages.sendMessage(this, email, raw, options);
  }

  createDraft(
    email: string,
    raw: Uint8Array | string,
    options: { threadId?: string } = {}
  ): { id: string; message: SemanticMessage } {
    return drafts.createDraft(this, email, raw, options);
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
    return drafts.createComposedDraft(this, email, input);
  }

  listDrafts(email: string, query = ""): Array<{ id: string; message: SemanticMessage }> {
    return drafts.listDrafts(this, email, query);
  }

  drafts(email: string, query = "", includeTrash = false): drafts.DraftResource[] {
    return drafts.drafts(this, email, query, includeTrash);
  }

  draft(email: string, draftId: string): drafts.DraftResource {
    return drafts.draft(this, email, draftId);
  }

  updateDraft(
    email: string,
    draftId: string,
    raw: Uint8Array | string,
    options: { threadId?: string } = {}
  ): { id: string; message: SemanticMessage } {
    return drafts.updateDraft(this, email, draftId, raw, options);
  }

  sendDraft(email: string, draftId: string): ReturnType<typeof messages.sendMessage> {
    return drafts.sendDraft(this, email, draftId);
  }

  deleteDraft(email: string, draftId: string): void {
    drafts.deleteDraft(this, email, draftId);
  }

  modifyMessageLabels(email: string, messageId: string, add: string[] = [], remove: string[] = []): SemanticMessage {
    return messages.modifyMessageLabels(this, email, messageId, add, remove);
  }

  modifyThreadLabels(
    email: string,
    threadId: string,
    add: string[] = [],
    remove: string[] = []
  ): ReturnType<typeof messages.getThread> {
    return messages.modifyThreadLabels(this, email, threadId, add, remove);
  }

  deleteMessage(email: string, messageId: string): void {
    messages.deleteMessage(this, email, messageId);
  }

  batchDeleteMessages(email: string, messageIds: string[]): void {
    messages.batchDeleteMessages(this, email, messageIds);
  }

  deleteThread(email: string, threadId: string): void {
    messages.deleteThread(this, email, threadId);
  }

  headers(email: string, messageId: string): Array<{ name: string; value: string }> {
    return messages.headers(this, email, messageId);
  }

  attachment(email: string, messageId: string, attachmentId: string): { size: number; data: string } {
    return messages.attachment(this, email, messageId, attachmentId);
  }

  applyInternalDateSource(
    email: string,
    messageId: string,
    source: "receivedTime" | "dateHeader"
  ): SemanticMessage {
    return messages.applyInternalDateSource(this, email, messageId, source);
  }

  createLabel(
    email: string,
    name: string,
    color?: { textColor?: string; backgroundColor?: string }
  ): { id: string; name: string } {
    return labels.createLabel(this, email, name, color);
  }

  listUserLabels(email: string): ReturnType<typeof labels.listUserLabels> {
    return labels.listUserLabels(this, email);
  }

  labels(email: string): labels.LabelResource[] {
    return labels.labels(this, email);
  }

  label(email: string, labelId: string): labels.LabelResource {
    return labels.label(this, email, labelId);
  }

  updateLabel(
    email: string,
    labelId: string,
    input: { name?: string; color?: { textColor?: string; backgroundColor?: string } },
    replace: boolean
  ): labels.LabelResource {
    return labels.updateLabel(this, email, labelId, input, replace);
  }

  deleteLabel(email: string, labelId: string): void {
    labels.deleteLabel(this, email, labelId);
  }

  filters(email: string): filters.FilterResource[] {
    return filters.filters(this, email);
  }

  filter(email: string, filterId: string): filters.FilterResource {
    return filters.filter(this, email, filterId);
  }

  createFilter(
    email: string,
    criteria: SeedFilter["criteria"] = {},
    action: SeedFilter["action"] = {}
  ): filters.FilterResource {
    return filters.createFilter(this, email, criteria, action);
  }

  deleteFilter(email: string, filterId: string): void {
    filters.deleteFilter(this, email, filterId);
  }

  listHistory(
    email: string,
    startHistoryId: string,
    options: { types?: string[] } = {}
  ): { history: HistoryEvent[]; historyId: string } {
    return settings.listHistory(this, email, startHistoryId, options);
  }

  profile(email: string): ReturnType<typeof settings.profile> {
    return settings.profile(this, email);
  }

  currentHistoryIdFor(email: string): string {
    return settings.currentHistoryIdFor(this, email);
  }

  latestMessageHistory(email: string, messageId: string): string {
    return settings.latestMessageHistory(this, email, messageId);
  }

  latestThreadHistory(email: string, threadId: string): string {
    return settings.latestThreadHistory(this, email, threadId);
  }

  forwardingAddresses(email: string): ReturnType<typeof settings.forwardingAddresses> {
    return settings.forwardingAddresses(this, email);
  }

  forwardingAddress(email: string, forwardingEmail: string): ReturnType<typeof settings.forwardingAddress> {
    return settings.forwardingAddress(this, email, forwardingEmail);
  }

  sendAs(email: string): Array<Record<string, unknown>> {
    return settings.sendAs(this, email);
  }

  sendAsAddress(email: string, sendAsEmail: string): Record<string, unknown> {
    return settings.sendAsAddress(this, email, sendAsEmail);
  }

  searchMessages(email: string, query = "", options: { includeTrash?: boolean } = {}): SemanticMessage[] {
    return messages.searchMessages(this, email, query, options);
  }

  searchThreads(
    email: string,
    query = "",
    options: { includeTrash?: boolean } = {}
  ): ReturnType<typeof messages.getThread>[] {
    return messages.searchThreads(this, email, query, options);
  }

  exportState(): GmailStateExport {
    return exportGmailState(this.db);
  }
}
