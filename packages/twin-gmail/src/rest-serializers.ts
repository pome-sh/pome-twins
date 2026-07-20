// SPDX-License-Identifier: Apache-2.0
import type { GmailDomain } from "./domain.js";
import { encodeGmailRaw } from "./mime.js";
import type { MessageFormat } from "./rest-common.js";
import type { GmailRestStore, LabelResource } from "./rest-store.js";
import type { HistoryEvent, SemanticMessage } from "./types.js";

export class GmailRestSerializers {
  constructor(
    private readonly domain: GmailDomain,
    private readonly store: GmailRestStore
  ) {}

  message(
    email: string,
    message: SemanticMessage,
    format: MessageFormat = "full",
    metadataHeaders: string[] = []
  ): Record<string, unknown> {
    const base = {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds,
      snippet: message.snippet,
      historyId: this.store.latestMessageHistory(email, message.id),
      internalDate: String(message.internalDate),
      sizeEstimate: message.sizeEstimate,
    };
    if (format === "minimal") return base;
    if (format === "raw") {
      return { ...base, raw: encodeGmailRaw(this.domain.getRaw(email, message.id)) };
    }
    const headers = this.store.headers(email, message.id);
    if (format === "metadata") {
      return {
        ...base,
        payload: {
          partId: "",
          mimeType: header(headers, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "text/plain",
          filename: "",
          headers: filterHeaders(headers, metadataHeaders),
          body: { size: 0 },
        },
      };
    }
    return { ...base, payload: fullPayload(message, headers) };
  }

  thread(
    email: string,
    thread: ReturnType<GmailDomain["getThread"]>,
    format: Exclude<MessageFormat, "raw"> = "full",
    metadataHeaders: string[] = []
  ): Record<string, unknown> {
    const latest = thread.messages.at(-1);
    return {
      id: thread.id,
      historyId: this.store.latestThreadHistory(email, thread.id),
      ...(latest?.snippet ? { snippet: latest.snippet } : {}),
      messages: thread.messages.map((message) => this.message(email, message, format, metadataHeaders)),
    };
  }

  draft(
    email: string,
    draft: { id: string; message: SemanticMessage },
    format: MessageFormat = "full"
  ): Record<string, unknown> {
    return { id: draft.id, message: this.message(email, draft.message, format) };
  }
}

export function labelSummary(label: LabelResource): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    type: label.type,
    messageListVisibility: "show",
    labelListVisibility: "labelShow",
    ...(label.textColor && label.backgroundColor
      ? { color: { textColor: label.textColor, backgroundColor: label.backgroundColor } }
      : {}),
  };
}

export function labelDetail(label: LabelResource): Record<string, unknown> {
  return {
    ...labelSummary(label),
    messagesTotal: label.messagesTotal,
    messagesUnread: label.messagesUnread,
    threadsTotal: label.threadsTotal,
    threadsUnread: label.threadsUnread,
  };
}

export function historyResource(event: HistoryEvent): Record<string, unknown> | null {
  if (!event.messageId || !event.threadId) return null;
  const message = { id: event.messageId, threadId: event.threadId };
  const base: Record<string, unknown> = { id: event.id, messages: [message] };
  if (event.type === "messageAdded" || event.type === "draftCreated") {
    base.messagesAdded = [{ message }];
  } else if (event.type === "messageDeleted" || ["draftDeleted", "draftReplaced", "draftSent"].includes(event.type)) {
    base.messagesDeleted = [{ message }];
  } else if (event.type === "labelAdded") {
    base.labelsAdded = [{ message, labelIds: event.labelIds }];
  } else if (event.type === "labelRemoved") {
    base.labelsRemoved = [{ message, labelIds: event.labelIds }];
  } else {
    return null;
  }
  return base;
}

function fullPayload(
  message: SemanticMessage,
  headers: Array<{ name: string; value: string }>
): Record<string, unknown> {
  const declaredType = header(headers, "content-type")?.split(";")[0]?.trim().toLowerCase();
  const contentParts: Array<Record<string, unknown>> = [];
  if (message.text) contentParts.push(inlinePart(String(contentParts.length), "text/plain", message.text));
  if (message.html) contentParts.push(inlinePart(String(contentParts.length), "text/html", message.html));
  for (const attachment of message.attachments) {
    contentParts.push({
      partId: String(contentParts.length),
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      headers: [
        { name: "Content-Type", value: attachment.mimeType },
        { name: "Content-Disposition", value: `${attachment.disposition}; filename="${attachment.filename}"` },
        ...(attachment.contentId ? [{ name: "Content-ID", value: `<${attachment.contentId}>` }] : []),
      ],
      body: { attachmentId: attachment.id, size: attachment.size },
    });
  }
  if (contentParts.length === 1 && message.attachments.length === 0) {
    const only = contentParts[0]!;
    return {
      partId: "",
      mimeType: declaredType ?? only.mimeType,
      filename: "",
      headers,
      body: only.body,
    };
  }
  return {
    partId: "",
    mimeType: declaredType ?? "multipart/mixed",
    filename: "",
    headers,
    body: { size: 0 },
    ...(contentParts.length ? { parts: contentParts } : {}),
  };
}

function inlinePart(partId: string, mimeType: string, value: string): Record<string, unknown> {
  const bytes = Buffer.from(value, "utf8");
  return {
    partId,
    mimeType,
    filename: "",
    headers: [{ name: "Content-Type", value: `${mimeType}; charset=utf-8` }],
    body: { size: bytes.length, data: bytes.toString("base64url") },
  };
}

function filterHeaders(
  headers: Array<{ name: string; value: string }>,
  selected: string[]
): Array<{ name: string; value: string }> {
  if (!selected.length) return headers;
  const names = new Set(selected.map((item) => item.toLowerCase()));
  return headers.filter((item) => names.has(item.name.toLowerCase()));
}

function header(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find((item) => item.name.toLowerCase() === name)?.value;
}
