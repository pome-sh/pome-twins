// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  GmailDomain,
  composeMime,
  defaultSeedState,
  encodeGmailRaw,
  gmailStateDelta,
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
  // Unit fixtures start empty; defaultSeedState() carries the agent-path inbox.
  gmail.seed({
    ...defaultSeedState(),
    deliveryMode,
    primaryMailbox: {
      email: sender,
      displayName: "Pome Agent",
      labels: [],
      messages: [],
      drafts: [],
      filters: [],
      forwardingAddresses: [],
      sendAs: [],
    },
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
    expect(() =>
      parseSeed({
        primaryMailbox: {
          email: sender,
          filters: [{ criteria: { query: "category:meetings" }, action: { addLabelIds: ["STARRED"] } }],
        },
      })
    ).toThrow(/Unsupported search category/);
    expect(() =>
      parseSeed({
        primaryMailbox: {
          email: sender,
          filters: [{ criteria: { negatedQuery: "myop:value" }, action: { addLabelIds: ["STARRED"] } }],
        },
      })
    ).toThrow(/Unsupported search operator/);
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
      response_body: {
        plaintextBody: "MIME-CANARY-plaintext",
        html: "<p>MIME-CANARY-html</p>",
        snippet: "MIME-CANARY-snippet",
      },
      state_delta: {
        before: null,
        after: { messages: [{ id: "m1", text: "MIME-CANARY-delta", html: "<b>x</b>", snippet: "MIME-CANARY-delta-snip" }] },
      },
      error: null,
    } as unknown as RecorderEvent;
    const projected = projectGmailRecording(event);
    const tape = JSON.stringify(projected);
    expect(tape).not.toContain("secret");
    expect(tape).not.toContain("MIME-CANARY");
    expect(projected.request_body).toMatchObject({
      raw: { sha256: expect.any(String), size: 11 },
      attachmentData: { sha256: expect.any(String), size: 6 },
    });
    expect(projected.response_body).toMatchObject({
      snippet: { sha256: expect.any(String), size: "MIME-CANARY-snippet".length },
    });
  });

  it("emits bounded state_delta summaries without plaintext bodies", () => {
    const { gmail } = domain();
    const before = gmail.exportState();
    const canary = "STATE-DELTA-MIME-CANARY";
    gmail.insertMessage(sender, raw("Delta", canary));
    const delta = gmailStateDelta(before, gmail.exportState());
    expect(delta).not.toBeNull();
    const tape = JSON.stringify(delta);
    expect(tape).not.toContain(canary);
    for (const message of [...(delta!.before?.messages ?? []), ...(delta!.after?.messages ?? [])]) {
      expect(message).not.toHaveProperty("text");
      expect(message).not.toHaveProperty("html");
      expect(message).not.toHaveProperty("snippet");
      expect(message).toMatchObject({ bodyOmitted: true });
    }
    expect(delta!.after?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: "Delta", bodyOmitted: true }),
      ])
    );
    expect(delta!.before?.messages ?? []).toEqual([]);
  });

  it("returns null state_delta for identical before/after exports", () => {
    const { gmail } = domain();
    const state = gmail.exportState();
    expect(gmailStateDelta(state, state)).toBeNull();
  });

  it("builds snippets with linear HTML strip (no ReDoS regex)", () => {
    const { gmail } = domain();
    const adversarial = `<${"a".repeat(50_000)}`;
    const message = gmail.insertMessage(
      sender,
      composeMime({
        from: sender,
        to: [recipient],
        subject: "Html strip",
        html: `<p>SNIPPET-VISIBLE ${adversarial}</p>`,
        date: "2025-01-01T12:00:00.000Z",
        messageId: "html-strip@test",
      })
    );
    expect(message.snippet).toContain("SNIPPET-VISIBLE");
    expect(message.snippet).not.toContain("<");
  });

  it("maps category:primary and rejects unknown search operators", () => {
    const { gmail } = domain();
    const message = gmail.insertMessage(sender, raw("Category"));
    gmail.modifyMessageLabels(sender, message.id, ["CATEGORY_PERSONAL"]);
    expect(gmail.searchMessages(sender, "category:primary")).toHaveLength(1);
    expect(() => gmail.searchMessages(sender, "xyzzy:nope")).toThrow(/Unsupported search operator/);
    expect(() => gmail.searchMessages(sender, "category:not-a-real-bucket")).toThrow(
      /Unsupported search category/
    );
  });

  it("joins replies onto threads via In-Reply-To / References", () => {
    const { gmail } = domain();
    const parent = gmail.insertMessage(sender, raw("Thread join", "parent", { messageId: "parent@test" }));
    const reply = gmail.insertMessage(
      sender,
      composeMime({
        from: recipient,
        to: [sender],
        subject: "Re: Thread join",
        text: "reply",
        date: "2025-01-01T13:00:00.000Z",
        messageId: "reply@test",
        inReplyTo: "parent@test",
        references: ["parent@test"],
      })
    );
    expect(reply.threadId).toBe(parent.threadId);
  });

  it("records history for filter-applied label changes", () => {
    const { gmail } = domain();
    gmail.seed({
      ...defaultSeedState(),
      deliveryMode: "sender-only",
      primaryMailbox: {
        email: sender,
        filters: [{ criteria: { subject: "Filtered" }, action: { addLabelIds: ["STARRED"] } }],
      },
    });
    const message = gmail.insertMessage(sender, raw("Filtered"), { incoming: true });
    expect(message.labelIds).toContain("STARRED");
    const history = gmail.listHistory(sender, "0");
    expect(history.history.some((event) => event.type === "labelAdded" && event.labelIds.includes("STARRED"))).toBe(
      true
    );
  });
});
