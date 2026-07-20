// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  GmailDomain,
  composeMime,
  defaultSeedState,
  encodeGmailRaw,
  identityFromSession,
  openGmailTwinDatabase,
  parseSeed,
  projectGmailRecording,
  resolveUserEmail,
} from "../src/index.js";
import type { RecorderEvent } from "@pome-sh/sdk";

const sender = "pome-agent@pome-twin.test";
const recipient = "local@pome-twin.test";

function raw(subject: string, body = "hello", extras: { to?: string[]; bcc?: string[]; messageId?: string } = {}) {
  return composeMime({
    from: sender,
    to: extras.to ?? [recipient],
    bcc: extras.bcc,
    subject,
    text: body,
    date: "2025-01-01T12:00:00.000Z",
    messageId: extras.messageId ?? `${subject.toLowerCase().replace(/\W/g, "-")}@test`,
  });
}

function domain(deliveryMode: "sender-only" | "seeded-mailboxes" = "sender-only") {
  const db = openGmailTwinDatabase(":memory:");
  const gmail = new GmailDomain(db);
  gmail.seed({
    ...defaultSeedState(),
    deliveryMode,
    mailboxes: [{ email: recipient }],
  });
  return { db, gmail };
}

describe("Gmail domain", () => {
  it("strict-parses seeds and resolves the frozen identity", () => {
    expect(() => parseSeed({ primaryMailbox: { email: sender }, extra: true })).toThrow();
    expect(identityFromSession(undefined).email).toBe(sender);
    expect(identityFromSession({ sid: "s", gmail_email: "USER@Example.COM" }).email).toBe("user@example.com");
    expect(resolveUserEmail("me", { sid: "s", gmail_email: sender })).toBe(sender);
    expect(() => resolveUserEmail(recipient, { sid: "s", gmail_email: sender })).toThrow();
  });

  it("round-trips exact canonical MIME bytes", () => {
    const { gmail } = domain();
    const bytes = Buffer.from(
      "From: pome-agent@pome-twin.test\r\nTo: local@pome-twin.test\r\n" +
        "Subject: Folded\r\n\tvalue\r\nMessage-ID: <raw@test>\r\nDate: Wed, 01 Jan 2025 12:00:00 GMT\r\n\r\nbody\r\n",
      "utf8"
    );
    const message = gmail.insertMessage(sender, encodeGmailRaw(bytes));
    expect(gmail.getRaw(sender, message.id)).toEqual(bytes);
  });

  it("preserves draft IDs while replacing message IDs, then creates a sent ID", () => {
    const { gmail } = domain();
    const created = gmail.createDraft(sender, raw("Draft one"));
    expect(created.message.labelIds).toEqual(["DRAFT"]);
    const updated = gmail.updateDraft(sender, created.id, raw("Draft two"));
    expect(updated.id).toBe(created.id);
    expect(updated.message.id).not.toBe(created.message.id);
    expect(() => gmail.getMessage(sender, created.message.id)).toThrow();
    const sent = gmail.sendDraft(sender, created.id);
    expect(sent.sender.id).not.toBe(updated.message.id);
    expect(sent.sender.labelIds).toEqual(["SENT"]);
  });

  it("keeps labels on messages and computes thread labels", () => {
    const { gmail } = domain();
    const label = gmail.createLabel(sender, "Project");
    const message = gmail.insertMessage(sender, raw("Labels"));
    gmail.modifyMessageLabels(sender, message.id, [label.id]);
    expect(gmail.getThread(sender, message.threadId).labelIds).toContain(label.id);
    gmail.modifyThreadLabels(sender, message.threadId, [], [label.id]);
    expect(gmail.getThread(sender, message.threadId).labelIds).not.toContain(label.id);
  });

  it("uses exclusive monotonic history IDs", () => {
    const { gmail } = domain();
    const first = gmail.insertMessage(sender, raw("History"));
    gmail.modifyMessageLabels(sender, first.id, ["STARRED"]);
    const history = gmail.listHistory(sender, "1");
    expect(history.history.every((event) => Number(event.id) > 1)).toBe(true);
    expect(history.historyId).toBe(String(Number(history.history.at(-1)?.id)));
  });

  it("supports operator search and message-first thread expansion", () => {
    const { gmail } = domain();
    const first = gmail.insertMessage(sender, raw("Quarterly project", "proposal holiday vacation"));
    gmail.insertMessage(sender, raw("Other", "nothing"));
    expect(gmail.searchMessages(sender, 'subject:quarterly AND "holiday vacation"')).toHaveLength(1);
    expect(gmail.searchMessages(sender, "subject:(quarterly project)")).toHaveLength(1);
    expect(gmail.searchMessages(sender, "holiday AROUND 2 vacation")[0]?.id).toBe(first.id);
    expect(gmail.searchThreads(sender, "from:pome-agent@pome-twin.test").length).toBe(2);
  });

  it("delivers once per seeded recipient, removes Bcc, and keeps sender Bcc", () => {
    const { db, gmail } = domain("seeded-mailboxes");
    const spoofed = composeMime({
      from: "spoofed@example.test",
      to: [recipient],
      subject: "Spoof",
      text: "body",
      date: "2025-01-01T12:00:00.000Z",
      messageId: "spoof@test",
    });
    expect(() => gmail.sendMessage(sender, spoofed)).toThrow(/send-as/);
    const result = gmail.sendMessage(sender, raw("Delivery", "body", { to: [recipient, recipient], bcc: [recipient] }));
    expect(result.deliveries).toHaveLength(1);
    expect(gmail.getRaw(sender, result.sender.id).toString()).toContain("Bcc:");
    const recipientRaw = gmail.getRaw(recipient, result.deliveries[0]!.message.id).toString();
    expect(recipientRaw).not.toContain("Bcc:");
    expect(result.deliveries[0]!.message.rfcMessageId).toBe(result.sender.rfcMessageId);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("exports complete deterministic semantic state without binary bytes", () => {
    const { gmail } = domain();
    const attachment = Buffer.from("binary-canary").toString("base64");
    gmail.insertMessage(
      sender,
      composeMime({
        from: sender,
        to: [recipient],
        subject: "Attachment",
        text: "body",
        date: "2025-01-01T12:00:00.000Z",
        messageId: "attachment@test",
        attachments: [{ filename: "a.bin", data: attachment }],
      })
    );
    const state = gmail.exportState();
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("binary-canary");
    expect(state).toHaveProperty("attachments");
    expect(state).toHaveProperty("messages");
    expect(gmail.exportState()).toEqual(state);
  });

  it("projects MIME and attachment payloads before recording", () => {
    const event = {
      request_body: { raw: Buffer.from("secret mime").toString("base64url"), attachmentData: "YmluYXJ5" },
      response_body: null,
      error: null,
    } as RecorderEvent;
    const projected = projectGmailRecording(event);
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(projected.request_body).toMatchObject({
      raw: { sha256: expect.any(String), size: 11 },
      attachmentData: { sha256: expect.any(String), size: 6 },
    });
  });
});
