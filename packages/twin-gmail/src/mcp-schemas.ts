// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const email = z.string().trim().email();
const pageSize = z.number().int().min(1).max(50).optional();
const pageToken = z.string().optional();
const labelIds = z.array(z.string().min(1)).min(1).max(100);

const labelColorSchema = z
  .object({
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
  })
  .passthrough();

const attachmentInputSchema = z
  .object({
    content: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
    contentId: z.string().max(998).optional(),
    filename: z.string().optional(),
    id: z.string().optional(),
    inline: z.boolean().optional(),
    mimeType: z.string().optional(),
  })
  .passthrough();

export const createDraftInputSchema = z
  .object({
    attachments: z.array(attachmentInputSchema).max(100).optional(),
    bcc: z.array(email).max(500).optional(),
    body: z.string().optional(),
    cc: z.array(email).max(500).optional(),
    htmlBody: z.string().optional(),
    replyToMessageId: z.string().min(1).optional(),
    subject: z.string().optional(),
    to: z.array(email).max(500).optional(),
  })
  .passthrough();

export const listDraftsInputSchema = z
  .object({
    pageSize,
    pageToken,
    query: z.string().max(4096).optional(),
    view: z
      .enum(["DRAFT_VIEW_UNSPECIFIED", "DRAFT_VIEW_METADATA_ONLY", "DRAFT_VIEW_FULL"])
      .optional(),
  })
  .passthrough();

export const getThreadInputSchema = z
  .object({
    messageFormat: z
      .enum(["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY"])
      .optional(),
    threadId: z.string().min(1),
  })
  .passthrough();

export const getMessageInputSchema = z
  .object({
    messageFormat: z
      .enum(["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY"])
      .optional(),
    messageId: z.string().min(1),
  })
  .passthrough();

export const searchThreadsInputSchema = z
  .object({
    includeTrash: z.boolean().optional(),
    pageSize,
    pageToken,
    query: z.string().max(4096).optional(),
    view: z
      .enum(["THREAD_VIEW_UNSPECIFIED", "THREAD_VIEW_METADATA_ONLY", "THREAD_VIEW_MINIMAL"])
      .optional(),
  })
  .passthrough();

export const threadLabelsInputSchema = z
  .object({
    labelIds,
    threadId: z.string().min(1),
  })
  .passthrough();

export const sensitiveThreadLabelInputSchema = z
  .object({
    labelOption: z.enum(["LABEL_OPTION_UNSPECIFIED", "TRASH", "SPAM"]),
    threadId: z.string().min(1),
  })
  .passthrough();

export const sensitiveMessageLabelInputSchema = z
  .object({
    labelOption: z.enum(["LABEL_OPTION_UNSPECIFIED", "TRASH", "SPAM"]),
    messageId: z.string().min(1),
  })
  .passthrough();

export const listLabelsInputSchema = z
  .object({
    pageSize,
    pageToken,
  })
  .passthrough();

export const messageLabelsInputSchema = z
  .object({
    labelIds,
    messageId: z.string().min(1),
  })
  .passthrough();

export const createLabelInputSchema = z
  .object({
    autoCreateParentLabels: z.boolean().optional(),
    color: labelColorSchema.optional(),
    displayName: z.string().trim().min(1).max(225),
  })
  .passthrough();

const draftOutputSchema = z
  .object({
    bccRecipients: z.array(z.string()).optional(),
    ccRecipients: z.array(z.string()).optional(),
    date: z.string().optional(),
    htmlBody: z.string().optional(),
    id: z.string().optional(),
    plaintextBody: z.string().optional(),
    subject: z.string().optional(),
    threadId: z.string().optional(),
    toRecipients: z.array(z.string()).optional(),
  })
  .passthrough();

const attachmentOutputSchema = z
  .object({
    filename: z.string().optional(),
    id: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .passthrough();

const messageOutputSchema = z
  .object({
    attachmentIds: z.array(z.string()).optional(),
    attachments: z.array(attachmentOutputSchema).optional(),
    ccRecipients: z.array(z.string()).optional(),
    date: z.string().optional(),
    htmlBody: z.string().optional(),
    id: z.string().optional(),
    labelIds: z.array(z.string()).optional(),
    plaintextBody: z.string().optional(),
    sender: z.string().optional(),
    snippet: z.string().optional(),
    subject: z.string().optional(),
    toRecipients: z.array(z.string()).optional(),
  })
  .passthrough();

const threadOutputSchema = z
  .object({
    id: z.string().optional(),
    messages: z.array(messageOutputSchema).optional(),
  })
  .passthrough();

const labelOutputSchema = z
  .object({
    color: labelColorSchema.optional(),
    labelId: z.string().optional(),
    name: z.string().optional(),
    threadsTotal: z.number().int().optional(),
    threadsUnread: z.number().int().optional(),
  })
  .passthrough();

export const mcpOutputSchemas = {
  create_draft: draftOutputSchema,
  list_drafts: z
    .object({ drafts: z.array(draftOutputSchema).optional(), nextPageToken: z.string().optional() })
    .passthrough(),
  get_thread: threadOutputSchema,
  get_message: messageOutputSchema,
  search_threads: z
    .object({
      nextPageToken: z.string().optional(),
      resultCountEstimate: z.string().optional(),
      threads: z.array(threadOutputSchema).optional(),
    })
    .passthrough(),
  label_thread: z.object({}).passthrough(),
  unlabel_thread: z.object({}).passthrough(),
  apply_sensitive_thread_label: z.object({}).passthrough(),
  list_labels: z
    .object({ labels: z.array(labelOutputSchema).optional(), nextPageToken: z.string().optional() })
    .passthrough(),
  label_message: z.object({}).passthrough(),
  unlabel_message: z.object({}).passthrough(),
  apply_sensitive_message_label: z.object({}).passthrough(),
  create_label: labelOutputSchema,
} as const;

export type CreateDraftInput = z.output<typeof createDraftInputSchema>;
export type ListDraftsInput = z.output<typeof listDraftsInputSchema>;
export type GetThreadInput = z.output<typeof getThreadInputSchema>;
export type GetMessageInput = z.output<typeof getMessageInputSchema>;
export type SearchThreadsInput = z.output<typeof searchThreadsInputSchema>;
export type ThreadLabelsInput = z.output<typeof threadLabelsInputSchema>;
export type SensitiveThreadLabelInput = z.output<typeof sensitiveThreadLabelInputSchema>;
export type ListLabelsInput = z.output<typeof listLabelsInputSchema>;
export type MessageLabelsInput = z.output<typeof messageLabelsInputSchema>;
export type SensitiveMessageLabelInput = z.output<typeof sensitiveMessageLabelInputSchema>;
export type CreateLabelInput = z.output<typeof createLabelInputSchema>;
