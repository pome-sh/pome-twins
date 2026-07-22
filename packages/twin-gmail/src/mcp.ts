// SPDX-License-Identifier: Apache-2.0
import type { ToolCallContext, ToolSpec } from "@pome-sh/sdk";
import { z } from "zod";
import canonicalListing from "../fixtures/mcp-tools-list.canonical.json" with { type: "json" };
import { GmailDomain } from "./domain/index.js";
import { invalidArgument } from "./errors.js";
import { identityFromSession } from "./identity.js";
import {
  createDraftInputSchema,
  createLabelInputSchema,
  getMessageInputSchema,
  getThreadInputSchema,
  listDraftsInputSchema,
  listLabelsInputSchema,
  mcpOutputSchemas,
  messageLabelsInputSchema,
  searchThreadsInputSchema,
  sensitiveMessageLabelInputSchema,
  sensitiveThreadLabelInputSchema,
  threadLabelsInputSchema,
  type CreateDraftInput,
  type CreateLabelInput,
  type GetMessageInput,
  type GetThreadInput,
  type ListDraftsInput,
  type ListLabelsInput,
  type MessageLabelsInput,
  type SearchThreadsInput,
  type SensitiveMessageLabelInput,
  type SensitiveThreadLabelInput,
  type ThreadLabelsInput,
} from "./mcp-schemas.js";
import {
  decodePageToken,
  encodePageToken,
  normalizeListBinding,
} from "./page-tokens.js";
import { gmailStateDelta } from "./state.js";
import type { SemanticMessage } from "./types.js";

type ToolName = keyof typeof mcpOutputSchemas;
type CanonicalTool = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
};
type ToolImplementation = {
  schema: z.ZodType;
  mutation: boolean;
  handler: (
    domain: GmailDomain,
    args: Record<string, unknown>,
    ctx: ToolCallContext
  ) => unknown;
  contentText?: (value: unknown) => string;
};

const canonicalTools = canonicalListing.result.tools as CanonicalTool[];

const implementations: Record<ToolName, ToolImplementation> = {
  create_draft: {
    schema: createDraftInputSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as CreateDraftInput;
        const email = identityFromSession(ctx.session).email;
        const draft = domain.createComposedDraft(email, {
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.body,
          html: input.htmlBody,
          replyToMessageId: input.replyToMessageId,
          attachments: input.attachments?.map((attachment, index) => ({
            filename: attachment.filename ?? "",
            mimeType: attachment.mimeType,
            disposition: attachment.inline ? "inline" : "attachment",
            contentId: attachment.inline
              ? (attachment.contentId ?? attachment.filename ?? attachment.id ?? `inline-${index + 1}`)
              : undefined,
            data: attachment.content,
          })),
        });
        return draftResult(draft.id, draft.message, false);
      }),
  },
  list_drafts: {
    schema: listDraftsInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as ListDraftsInput;
      const email = identityFromSession(ctx.session).email;
      const drafts = domain.listDrafts(email, input.query ?? "");
      const page = paginate(domain, email, "drafts.list", drafts, input.pageSize, input.pageToken, {
        query: input.query ?? "",
        view: input.view ?? "DRAFT_VIEW_FULL",
      });
      return {
        drafts: page.items.map((draft) =>
          draftResult(
            draft.id,
            draft.message,
            input.view === "DRAFT_VIEW_METADATA_ONLY"
          )
        ),
        ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      };
    },
  },
  get_thread: {
    schema: getThreadInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as GetThreadInput;
      const email = identityFromSession(ctx.session).email;
      return threadResult(
        domain.getThread(email, input.threadId),
        normalizeMessageFormat(input.messageFormat)
      );
    },
  },
  get_message: {
    schema: getMessageInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as GetMessageInput;
      const email = identityFromSession(ctx.session).email;
      return messageResult(
        domain.getMessage(email, input.messageId),
        normalizeMessageFormat(input.messageFormat)
      );
    },
  },
  search_threads: {
    schema: searchThreadsInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as SearchThreadsInput;
      const email = identityFromSession(ctx.session).email;
      const threads = domain.searchThreads(email, input.query ?? "", {
        includeTrash: input.includeTrash,
      });
      const page = paginate(domain, email, "threads.search", threads, input.pageSize, input.pageToken, {
        includeTrash: input.includeTrash ?? false,
        query: input.query ?? "",
        view: input.view ?? "THREAD_VIEW_MINIMAL",
      });
      return {
        threads: page.items.map((thread) =>
          threadResult(
            thread,
            input.view === "THREAD_VIEW_METADATA_ONLY" ? "metadata" : "minimal"
          )
        ),
        ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      };
    },
  },
  label_thread: labelThreadImplementation(true),
  unlabel_thread: labelThreadImplementation(false),
  apply_sensitive_thread_label: {
    schema: sensitiveThreadLabelInputSchema,
    mutation: true,
    contentText: () => "OK",
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as SensitiveThreadLabelInput;
        const label = resolveSensitiveLabel(input.labelOption);
        const other = label === "TRASH" ? "SPAM" : "TRASH";
        domain.modifyThreadLabels(
          identityFromSession(ctx.session).email,
          input.threadId,
          [label],
          ["INBOX", other]
        );
        return {};
      }),
  },
  list_labels: {
    schema: listLabelsInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as ListLabelsInput;
      const email = identityFromSession(ctx.session).email;
      const page = paginate(
        domain,
        email,
        "labels.list",
        domain.listUserLabels(email),
        input.pageSize,
        input.pageToken,
        {}
      );
      return {
        labels: page.items.map(labelResult),
        ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      };
    },
  },
  label_message: labelMessageImplementation(true),
  unlabel_message: labelMessageImplementation(false),
  apply_sensitive_message_label: {
    schema: sensitiveMessageLabelInputSchema,
    mutation: true,
    contentText: () => "OK",
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as SensitiveMessageLabelInput;
        const label = resolveSensitiveLabel(input.labelOption);
        const other = label === "TRASH" ? "SPAM" : "TRASH";
        domain.modifyMessageLabels(
          identityFromSession(ctx.session).email,
          input.messageId,
          [label],
          ["INBOX", other]
        );
        return {};
      }),
  },
  create_label: {
    schema: createLabelInputSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as CreateLabelInput;
        const email = identityFromSession(ctx.session).email;
        if (input.autoCreateParentLabels !== false) {
          const parts = input.displayName.split("/");
          for (let index = 1; index < parts.length; index += 1) {
            const parent = parts.slice(0, index).join("/");
            const exists = domain
              .listUserLabels(email)
              .some((label) => label.name.toLowerCase() === parent.toLowerCase());
            if (!exists) domain.createLabel(email, parent);
          }
        }
        const created = domain.createLabel(email, input.displayName, input.color);
        const label = domain.listUserLabels(email).find((item) => item.id === created.id);
        if (!label) throw new Error("Created label was not found");
        return labelResult(label);
      }),
  },
};

export const gmailTools: ToolSpec<GmailDomain>[] = canonicalTools.map((canonical) => {
  const implementation = implementations[canonical.name];
  if (!implementation) throw new Error(`Missing Gmail MCP implementation: ${canonical.name}`);
  return {
    name: canonical.name,
    description: canonical.description,
    schema: implementation.schema,
    inputSchema: canonical.inputSchema,
    outputSchema: canonical.outputSchema,
    annotations: canonical.annotations,
    mutation: implementation.mutation,
    includeIsError: true,
    handler: (domain, args, ctx) => {
      const output = implementation.handler(
        domain,
        args as Record<string, unknown>,
        ctx
      );
      return mcpOutputSchemas[canonical.name].parse(output);
    },
    ...(implementation.contentText
      ? { contentText: implementation.contentText }
      : {}),
  } as ToolSpec<GmailDomain>;
});

function labelThreadImplementation(add: boolean): ToolImplementation {
  return {
    schema: threadLabelsInputSchema,
    mutation: true,
    contentText: () => "OK",
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as ThreadLabelsInput;
        domain.modifyThreadLabels(
          identityFromSession(ctx.session).email,
          input.threadId,
          add ? input.labelIds : [],
          add ? [] : input.labelIds
        );
        return {};
      }),
  };
}

function labelMessageImplementation(add: boolean): ToolImplementation {
  return {
    schema: messageLabelsInputSchema,
    mutation: true,
    contentText: () => "OK",
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as MessageLabelsInput;
        domain.modifyMessageLabels(
          identityFromSession(ctx.session).email,
          input.messageId,
          add ? input.labelIds : [],
          add ? [] : input.labelIds
        );
        return {};
      }),
  };
}

function mutate<T>(domain: GmailDomain, ctx: ToolCallContext, operation: () => T): T {
  const before = domain.exportState();
  const output = operation();
  ctx.reportDelta(gmailStateDelta(before, domain.exportState()));
  return output;
}

function draftResult(id: string, message: SemanticMessage, metadataOnly: boolean) {
  return {
    id,
    threadId: message.threadId,
    toRecipients: message.to,
    ccRecipients: message.cc,
    bccRecipients: message.bcc,
    date: dateOnly(message.internalDate),
    ...(!metadataOnly
      ? {
          subject: message.subject,
          plaintextBody: message.text,
          ...(message.html ? { htmlBody: message.html } : {}),
        }
      : {}),
  };
}

function threadResult(
  thread: { id: string; messages: SemanticMessage[] },
  format: "metadata" | "minimal" | "full"
) {
  return {
    id: thread.id,
    messages: thread.messages.map((message) => messageResult(message, format)),
  };
}

function messageResult(
  message: SemanticMessage,
  format: "metadata" | "minimal" | "full"
) {
  const metadata = {
    id: message.id,
    labelIds: message.labelIds,
    date: dateOnly(message.internalDate),
  };
  if (format === "metadata") return metadata;
  const minimal = {
    ...metadata,
    snippet: message.snippet,
    subject: message.subject,
    sender: message.from,
    toRecipients: message.to,
    ccRecipients: message.cc,
  };
  if (format === "minimal") return minimal;
  return {
    ...minimal,
    plaintextBody: message.text,
    ...(message.html ? { htmlBody: message.html } : {}),
    attachmentIds: message.attachments.map((attachment) => attachment.id),
    ...(message.attachments.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
          })),
        }
      : {}),
  };
}

function labelResult(label: {
  id: string;
  name: string;
  color?: { textColor?: string; backgroundColor?: string };
  threadsTotal: number;
  threadsUnread: number;
}) {
  return {
    labelId: label.id,
    name: label.name,
    ...(label.color ? { color: label.color } : {}),
    threadsTotal: label.threadsTotal,
    threadsUnread: label.threadsUnread,
  };
}

function normalizeMessageFormat(
  format: GetThreadInput["messageFormat"] | GetMessageInput["messageFormat"]
): "metadata" | "minimal" | "full" {
  if (format === "METADATA_ONLY") return "metadata";
  if (format === "MINIMAL") return "minimal";
  return "full";
}

function resolveSensitiveLabel(
  option: SensitiveThreadLabelInput["labelOption"] | SensitiveMessageLabelInput["labelOption"]
): "TRASH" | "SPAM" {
  if (option === "TRASH" || option === "SPAM") return option;
  invalidArgument("labelOption must be TRASH or SPAM");
}

function paginate<T>(
  domain: GmailDomain,
  email: string,
  route: string,
  items: T[],
  requestedSize: number | undefined,
  token: string | undefined,
  filter: Record<string, unknown>
): { items: T[]; nextPageToken?: string } {
  const size = requestedSize ?? 20;
  const snapshot = domain.currentHistoryIdFor(email);
  const binding = normalizeListBinding(route, email, filter);
  const offset = token ? decodePageToken(token, binding, snapshot) : 0;
  if (offset > items.length) invalidArgument("Invalid pageToken");
  const page = items.slice(offset, offset + size);
  const nextOffset = offset + page.length;
  return {
    items: page,
    ...(nextOffset < items.length
      ? { nextPageToken: encodePageToken(nextOffset, binding, snapshot) }
      : {}),
  };
}

function dateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
