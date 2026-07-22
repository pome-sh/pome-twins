// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { validateSearchQuery } from "./search-parse.js";
import type { GmailStateSeed, SeedMailbox } from "./types.js";

const email = z.string().trim().email().transform((value) => value.toLowerCase());
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

const attachmentSchema = z
  .object({
    filename: z.string().max(512),
    mimeType: z.string().min(1).max(255).default("application/octet-stream"),
    disposition: z.enum(["attachment", "inline"]).default("attachment"),
    contentId: z.string().max(998).optional(),
    data: z.string().max(50_000_000),
  })
  .strict();

const messageFields = {
  id: id.optional(),
  threadId: id.optional(),
  raw: z.string().max(50_000_000).optional(),
  from: email.optional(),
  to: z.array(email).max(500).default([]),
  cc: z.array(email).max(500).default([]),
  bcc: z.array(email).max(500).default([]),
  subject: z.string().max(998).default(""),
  text: z.string().max(25_000_000).default(""),
  html: z.string().max(25_000_000).default(""),
  date: z.string().datetime({ offset: true }).optional(),
  messageId: z.string().min(3).max(998).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).max(100).default([]),
  attachments: z.array(attachmentSchema).max(100).default([]),
};

const messageSchema = z
  .object({
    ...messageFields,
    labels: z.array(z.string().min(1).max(255)).max(100).default([]),
  })
  .strict();

const draftSchema = z.object(messageFields).strict();

const labelSchema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(225),
    color: z
      .object({
        textColor: z.string().max(32).optional(),
        backgroundColor: z.string().max(32).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const filterSchema = z
  .object({
    id: id.optional(),
    criteria: z
      .object({
        from: z.string().max(998).optional(),
        to: z.string().max(998).optional(),
        subject: z.string().max(998).optional(),
        query: z.string().max(4096).optional(),
        negatedQuery: z.string().max(4096).optional(),
        hasAttachment: z.boolean().optional(),
        excludeChats: z.boolean().optional(),
        size: z.number().int().nonnegative().optional(),
        sizeComparison: z.enum(["larger", "smaller"]).optional(),
      })
      .strict()
      .default({}),
    action: z
      .object({
        addLabelIds: z.array(z.string().min(1)).max(100).default([]),
        removeLabelIds: z.array(z.string().min(1)).max(100).default([]),
        forward: email.optional(),
      })
      .strict()
      .default({ addLabelIds: [], removeLabelIds: [] }),
  })
  .strict();

const sendAsSchema = z
  .object({
    sendAsEmail: email,
    displayName: z.string().max(256).default(""),
    replyToAddress: email.optional(),
    isPrimary: z.boolean().default(false),
    isDefault: z.boolean().default(false),
    verificationStatus: z.enum(["accepted", "pending"]).default("accepted"),
  })
  .strict();

const mailboxSchema = z
  .object({
    email,
    displayName: z.string().max(256).default(""),
    labels: z.array(labelSchema).max(5000).default([]),
    messages: z.array(messageSchema).max(10_000).default([]),
    drafts: z.array(draftSchema).max(5000).default([]),
    filters: z.array(filterSchema).max(1000).default([]),
    forwardingAddresses: z
      .array(
        z
          .object({
            forwardingEmail: email,
            verificationStatus: z.enum(["accepted", "pending"]).default("pending"),
          })
          .strict()
      )
      .max(1000)
      .default([]),
    sendAs: z.array(sendAsSchema).max(1000).default([]),
  })
  .strict();

export const gmailSeedSchema = z
  .object({
    primaryMailbox: mailboxSchema,
    mailboxes: z.array(mailboxSchema).max(100).default([]),
    deliveryMode: z.enum(["sender-only", "seeded-mailboxes"]).default("sender-only"),
    clock: z.string().datetime({ offset: true }).default("2025-01-01T00:00:00.000Z"),
  })
  .strict()
  .superRefine((seed, ctx) => {
    const emails = [seed.primaryMailbox.email, ...seed.mailboxes.map((mailbox) => mailbox.email)];
    const seen = new Set<string>();
    for (const mailboxEmail of emails) {
      if (seen.has(mailboxEmail)) {
        ctx.addIssue({ code: "custom", message: `Duplicate mailbox: ${mailboxEmail}` });
      }
      seen.add(mailboxEmail);
    }
    for (const mailbox of [seed.primaryMailbox, ...seed.mailboxes]) {
      const labelNames = new Set<string>();
      for (const label of mailbox.labels) {
        const key = label.name.toLowerCase();
        if (labelNames.has(key)) {
          ctx.addIssue({ code: "custom", message: `Duplicate label in ${mailbox.email}: ${label.name}` });
        }
        labelNames.add(key);
      }
      for (const filter of mailbox.filters) {
        if (filter.action.forward) {
          ctx.addIssue({
            code: "custom",
            message: `Filter forwarding is unsupported: ${mailbox.email}`,
          });
        }
        for (const key of ["query", "negatedQuery"] as const) {
          const value = filter.criteria[key];
          if (!value) continue;
          try {
            validateSearchQuery(value);
          } catch (error) {
            ctx.addIssue({
              code: "custom",
              message: `Invalid filter ${key} in ${mailbox.email}: ${(error as Error).message}`,
            });
          }
        }
      }
    }
  });

export type ParsedGmailStateSeed = z.output<typeof gmailSeedSchema>;

export function parseSeed(input: unknown): ParsedGmailStateSeed {
  return gmailSeedSchema.parse(input);
}

export function loadSeedFromEnv(env: NodeJS.ProcessEnv = process.env): ParsedGmailStateSeed {
  const raw = env.POME_SEED_JSON;
  if (!raw) return parseSeed(defaultSeedState());
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`POME_SEED_JSON is not valid JSON: ${(error as Error).message}`);
  }
  return parseSeed(parsed);
}

/** Primary agent mailbox used by default / scenario seeds. */
export const DEFAULT_GMAIL_AGENT_EMAIL = "pome-agent@pome-twin.test";

/**
 * Multi-thread inbox used by `defaultSeedState` and CLI Gmail scenarios:
 * welcome, build (+ reply), unread support, and an unsent draft.
 */
export function agentPathInboxMailbox(email: string = DEFAULT_GMAIL_AGENT_EMAIL): SeedMailbox {
  return {
    email,
    displayName: "Pome Agent",
    labels: [
      { id: "Label_follow_up", name: "Follow Up" },
      { id: "Label_build", name: "Build" },
    ],
    messages: [
      {
        id: "msg_welcome",
        threadId: "thread_welcome",
        from: "welcome@pome-twin.test",
        to: [email],
        subject: "Welcome to your Pome Gmail twin",
        text: "Your deterministic inbox is ready for agent testing.",
        html: "<p>Your deterministic inbox is ready for agent testing.</p>",
        date: "2026-07-18T09:00:00.000Z",
        messageId: "welcome@pome-twin.test",
        labels: ["INBOX"],
      },
      {
        id: "msg_build",
        threadId: "thread_build",
        from: "ci@example.com",
        to: [email],
        subject: "Build failed on main",
        text: "The nightly build failed. See the attached log.",
        date: "2026-07-19T10:00:00.000Z",
        messageId: "build-001@example.com",
        labels: ["INBOX", "UNREAD", "Build"],
        attachments: [
          {
            filename: "build.log",
            mimeType: "text/plain",
            data: Buffer.from("BUILD FAILED step=test\n", "utf8").toString("base64"),
          },
        ],
      },
      {
        id: "msg_build_reply",
        threadId: "thread_build",
        from: email,
        to: ["ci@example.com"],
        subject: "Re: Build failed on main",
        text: "Looking into the failure now.",
        date: "2026-07-19T11:00:00.000Z",
        messageId: "build-reply@pome-twin.test",
        inReplyTo: "build-001@example.com",
        references: ["build-001@example.com"],
        labels: ["SENT"],
      },
      {
        id: "msg_support",
        threadId: "thread_support",
        from: "alice@example.com",
        to: [email],
        subject: "Production export is stuck",
        text: "Our production export has been stuck for an hour. Can you investigate?",
        date: "2026-07-19T12:00:00.000Z",
        messageId: "support-001@example.com",
        labels: ["INBOX", "UNREAD"],
      },
    ],
    drafts: [
      {
        id: "draft_ack",
        threadId: "thread_draft_ack",
        to: ["bob@example.com"],
        subject: "Draft acknowledgment",
        text: "Thanks — I'll follow up shortly.",
        date: "2026-07-19T13:00:00.000Z",
        messageId: "draft-ack@pome-twin.test",
      },
    ],
    filters: [],
    forwardingAddresses: [],
    sendAs: [],
  };
}

export function defaultSeedState(): GmailStateSeed {
  return {
    primaryMailbox: agentPathInboxMailbox(),
    mailboxes: [],
    deliveryMode: "sender-only",
    clock: "2026-07-20T00:00:00.000Z",
  };
}
