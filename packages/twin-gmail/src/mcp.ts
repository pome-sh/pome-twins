// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ToolCallContext, ToolSpec } from "@pome-sh/sdk";
import { z } from "zod";
import canonicalListing from "../fixtures/mcp-tools-list.canonical.json" with { type: "json" };
import { GmailDomain } from "./domain.js";
import { invalidArgument } from "./errors.js";
import { identityFromSession } from "./identity.js";
import {
  createDraftInputSchema,
  createLabelInputSchema,
  getThreadInputSchema,
  listDraftsInputSchema,
  listLabelsInputSchema,
  mcpOutputSchemas,
  messageLabelsInputSchema,
  searchThreadsInputSchema,
  threadLabelsInputSchema,
  type CreateDraftInput,
  type CreateLabelInput,
  type GetThreadInput,
  type ListDraftsInput,
  type ListLabelsInput,
  type MessageLabelsInput,
  type SearchThreadsInput,
  type ThreadLabelsInput,
} from "./mcp-schemas.js";
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
const PAGE_TOKEN_KEY =
  process.env.POME_GMAIL_PAGE_TOKEN_SECRET ?? "pome-gmail-page-token-v1";

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
          attachments: input.attachments?.map((attachment) => ({
            filename: attachment.filename ?? "",
            mimeType: attachment.mimeType,
            disposition: attachment.inline ? "inline" : "attachment",
            contentId: attachment.inline ? attachment.filename : undefined,
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
      const page = paginate("drafts", drafts, input.pageSize, input.pageToken, {
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
        nextPageToken: page.nextPageToken,
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
  search_threads: {
    schema: searchThreadsInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as SearchThreadsInput;
      const email = identityFromSession(ctx.session).email;
      const threads = domain.searchThreads(email, input.query ?? "", {
        includeTrash: input.includeTrash,
      });
      const page = paginate("threads", threads, input.pageSize, input.pageToken, {
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
        nextPageToken: page.nextPageToken,
      };
    },
  },
  label_thread: labelThreadImplementation(true),
  unlabel_thread: labelThreadImplementation(false),
  list_labels: {
    schema: listLabelsInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as ListLabelsInput;
      const email = identityFromSession(ctx.session).email;
      const page = paginate(
        "labels",
        domain.listUserLabels(email),
        input.pageSize,
        input.pageToken,
        {}
      );
      return {
        labels: page.items.map(labelResult),
        nextPageToken: page.nextPageToken,
      };
    },
  },
  label_message: labelMessageImplementation(true),
  unlabel_message: labelMessageImplementation(false),
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
  format: GetThreadInput["messageFormat"]
): "metadata" | "minimal" | "full" {
  if (format === "METADATA_ONLY") return "metadata";
  if (format === "MINIMAL") return "minimal";
  return "full";
}

function paginate<T>(
  kind: string,
  items: T[],
  requestedSize: number | undefined,
  token: string | undefined,
  filter: unknown
): { items: T[]; nextPageToken: string } {
  const size = requestedSize ?? 20;
  const offset = token ? decodePageToken(token, kind, filter) : 0;
  if (offset > items.length) invalidArgument("Invalid pageToken");
  const page = items.slice(offset, offset + size);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextPageToken:
      nextOffset < items.length ? encodePageToken(kind, nextOffset, filter) : "",
  };
}

function encodePageToken(kind: string, offset: number, filter: unknown): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, kind, offset, filter: filterHash(filter) })
  ).toString("base64url");
  const signature = createHmac("sha256", PAGE_TOKEN_KEY)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function decodePageToken(token: string, kind: string, filter: unknown): number {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) invalidArgument("Invalid pageToken");
    const expected = createHmac("sha256", PAGE_TOKEN_KEY).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      invalidArgument("Invalid pageToken");
    }
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: unknown;
      kind?: unknown;
      offset?: unknown;
      filter?: unknown;
    };
    if (
      decoded.v !== 1 ||
      decoded.kind !== kind ||
      !Number.isSafeInteger(decoded.offset) ||
      (decoded.offset as number) < 0 ||
      decoded.filter !== filterHash(filter)
    ) {
      invalidArgument("Invalid pageToken");
    }
    return decoded.offset as number;
  } catch {
    invalidArgument("Invalid pageToken");
  }
}

function filterHash(filter: unknown): string {
  return createHash("sha256").update(JSON.stringify(filter)).digest("base64url").slice(0, 22);
}

function dateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
