// file-size: Shared seed-state Zod schemas across twins — kept together so seed contracts stay one module.
// SPDX-License-Identifier: Apache-2.0
//
// shared-types — provider seed-state schemas (part of §3 TASKS). The
// per-provider seed worlds (GitHub / Stripe / Slack), the provider-scoped
// wrapper, and the legacy-or-scoped `seedStateSchema` union consumed by
// `taskSchema`. Re-exported through the `@pome-sh/shared-types` barrel.

import { z } from "zod";

// SeedState — adopted as-is from oslo (nested shape; matches OSS code).
// Future twins (Linear, Slack) will add their own seed shapes; we union those
// in here as the family grows.
//
// FDRS-653 (ported from pome-cloud): this schema used to model only the
// issue-triage subset (repositories[].{issues,labels,collaborators}). Anywhere
// it is used as a narrowing boundary, a field MISSING here is silently
// zod-stripped before it reaches the twin pod's own parseSeed — which is
// exactly how PR-based scenarios lost their `users`, `pull_requests`, and
// `files` and booted into an empty repo (the agent saw `GET /pulls → []`).
// The full GitHub world (top-level users, default_branch, files,
// pull_requests with reviews/statuses) is modeled below, matching the
// canonical twin-github seed shape.
export const githubSeedStateSchema = z.object({
  users: z
    .array(
      z.object({
        login: z.string().min(1),
        type: z.enum(["User", "Organization"]).default("User"),
        name: z.string().default(""),
      })
    )
    .optional(),
  repositories: z
    .array(
      z.object({
        owner: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        default_branch: z.string().min(1).optional(),
        labels: z
          .array(
            z.object({
              name: z.string().min(1),
              color: z.string().default("ededed"),
              description: z.string().default(""),
            })
          )
          .default([]),
        collaborators: z.array(z.string().min(1)).default([]),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              content: z.string(),
              branch: z.string().optional(),
            })
          )
          .optional(),
        issues: z
          .array(
            z.object({
              number: z.number().int().positive(),
              title: z.string().min(1),
              body: z.string().default(""),
              state: z.enum(["open", "closed"]).default("open"),
              labels: z.array(z.string().min(1)).default([]),
              assignee: z.string().nullable().default(null),
            })
          )
          .default([]),
        pull_requests: z
          .array(
            z.object({
              number: z.number().int().positive().optional(),
              title: z.string().min(1),
              body: z.string().default(""),
              head: z.string().min(1),
              base: z.string().min(1).default("main"),
              state: z.enum(["open", "closed"]).default("open"),
              author: z.string().min(1).optional(),
              // Reviews seeded on this PR. State mirrors GitHub's review state
              // enum; author must exist in users or collaborators.
              reviews: z
                .array(
                  z.object({
                    author: z.string().min(1),
                    state: z
                      .enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"])
                      .default("APPROVED"),
                    body: z.string().default(""),
                  })
                )
                .default([]),
              // Commit statuses on the PR head SHA, wired into commit_statuses
              // so get_pull_request_status and merge_pull_request see them.
              statuses: z
                .array(
                  z.object({
                    context: z.string().min(1).default("ci/build"),
                    state: z
                      .enum(["error", "failure", "pending", "success"])
                      .default("success"),
                    description: z.string().default(""),
                  })
                )
                .default([]),
            })
          )
          .optional(),
      })
    )
    .min(1),
});
export type GithubSeedState = z.infer<typeof githubSeedStateSchema>;

export const stripeSeedStateSchema = z.object({
  api_keys: z
    .array(
      z.object({
        key: z.string().min(1).default("sk_test_pome_default"),
        sid: z.string().min(1).default("default"),
        account_id: z.string().min(1).optional(),
      })
    )
    .default([]),
  customers: z.array(z.record(z.string(), z.unknown())).default([]),
  products: z.array(z.record(z.string(), z.unknown())).default([]),
  prices: z.array(z.record(z.string(), z.unknown())).default([]),
  payment_intents: z.array(z.record(z.string(), z.unknown())).default([]),
  charges: z.array(z.record(z.string(), z.unknown())).default([]),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  balances: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type StripeSeedState = z.infer<typeof stripeSeedStateSchema>;

export const slackSeedStateSchema = z.object({
  team: z
    .object({
      id: z.string().regex(/^T[A-Z0-9_]+$/).optional(),
      name: z.string().default("Pome Twin Workspace"),
      domain: z.string().default("pome-twin"),
    })
    .prefault({}),
  users: z
    .array(
      z.object({
        id: z.string().regex(/^[UB][A-Z0-9_]+$/).optional(),
        name: z.string().min(1),
        real_name: z.string().default(""),
        email: z.string().email().optional(),
        is_bot: z.boolean().default(false),
        is_admin: z.boolean().default(false),
        tz: z.string().default("America/Los_Angeles"),
        profile: z.record(z.string(), z.unknown()).default({}),
      })
    )
    .default([]),
  channels: z
    .array(
      z.object({
        id: z.string().regex(/^[CGDM][A-Z0-9_]+$/).optional(),
        name: z.string().regex(/^[a-z0-9_-]{1,80}$/),
        is_private: z.boolean().default(false),
        topic: z.string().default(""),
        purpose: z.string().default(""),
        creator: z.string().optional(),
        members: z.array(z.string()).default([]),
        messages: z
          .array(
            z.object({
              ts: z.string().optional(),
              user: z.string(),
              text: z.string(),
              thread_ts: z.string().optional(),
              reactions: z
                .array(z.object({ name: z.string(), user: z.string() }))
                .default([]),
            })
          )
          .default([]),
      })
    )
    .default([]),
  emoji: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9_+-]{1,100}$/),
        url: z.string().url().optional(),
        alias: z.string().regex(/^[a-z0-9_+-]{1,100}$/).optional(),
      })
    )
    .default([]),
});
export type SlackSeedState = z.infer<typeof slackSeedStateSchema>;

const gmailEmailSchema = z.string().trim().email().transform((value) => value.toLowerCase());
const gmailIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

const gmailAttachmentSeedSchema = z.object({
  filename: z.string().max(512),
  mimeType: z.string().min(1).max(255).default("application/octet-stream"),
  disposition: z.enum(["attachment", "inline"]).default("attachment"),
  contentId: z.string().max(998).optional(),
  data: z.string().max(50_000_000),
});

const gmailMessageSeedFields = {
  id: gmailIdSchema.optional(),
  threadId: gmailIdSchema.optional(),
  raw: z.string().max(50_000_000).optional(),
  from: gmailEmailSchema.optional(),
  to: z.array(gmailEmailSchema).max(500).default([]),
  cc: z.array(gmailEmailSchema).max(500).default([]),
  bcc: z.array(gmailEmailSchema).max(500).default([]),
  subject: z.string().max(998).default(""),
  text: z.string().max(25_000_000).default(""),
  html: z.string().max(25_000_000).default(""),
  date: z.string().datetime({ offset: true }).optional(),
  messageId: z.string().min(3).max(998).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).max(100).default([]),
  attachments: z.array(gmailAttachmentSeedSchema).max(100).default([]),
};

/** Aligns with twin-gmail `seed.ts` filter shape; query AST is validated at twin parse time. */
const gmailFilterSeedSchema = z
  .object({
    id: gmailIdSchema.optional(),
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
      .default({}),
    action: z
      .object({
        addLabelIds: z.array(z.string().min(1)).max(100).default([]),
        removeLabelIds: z.array(z.string().min(1)).max(100).default([]),
        /** Twin rejects filter forwarding (no delivery); keep field for drift detection. */
        forward: gmailEmailSchema.optional(),
      })
      .default({ addLabelIds: [], removeLabelIds: [] }),
  })
  .superRefine((filter, ctx) => {
    if (filter.action.forward) {
      ctx.addIssue({
        code: "custom",
        message: "Filter forwarding is unsupported",
        path: ["action", "forward"],
      });
    }
  });

const gmailMailboxSeedSchema = z.object({
  email: gmailEmailSchema,
  displayName: z.string().max(256).default(""),
  labels: z
    .array(
      z.object({
        id: gmailIdSchema.optional(),
        name: z.string().trim().min(1).max(225),
        color: z
          .object({
            textColor: z.string().max(32).optional(),
            backgroundColor: z.string().max(32).optional(),
          })
          .optional(),
      }),
    )
    .max(5000)
    .default([]),
  messages: z
    .array(
      z.object({
        ...gmailMessageSeedFields,
        labels: z.array(z.string().min(1).max(255)).max(100).default([]),
      }),
    )
    .max(10_000)
    .default([]),
  drafts: z.array(z.object(gmailMessageSeedFields)).max(5000).default([]),
  filters: z.array(gmailFilterSeedSchema).max(1000).default([]),
  forwardingAddresses: z.array(z.record(z.string(), z.unknown())).max(1000).default([]),
  sendAs: z.array(z.record(z.string(), z.unknown())).max(1000).default([]),
});

export const gmailSeedStateSchema = z.object({
  primaryMailbox: gmailMailboxSeedSchema,
  mailboxes: z.array(gmailMailboxSeedSchema).max(100).default([]),
  deliveryMode: z.enum(["sender-only", "seeded-mailboxes"]).default("sender-only"),
  clock: z.string().datetime({ offset: true }).default("2025-01-01T00:00:00.000Z"),
});
export type GmailSeedState = z.infer<typeof gmailSeedStateSchema>;

/** Aligns with twin-linear `seed.ts` shape; twin parseSeed applies strict cross-refs. */
const linearEmailSchema = z.string().trim().email().transform((value) => value.toLowerCase());
const linearIdSchema = z.string().min(1).max(128);
const linearDatetimeSchema = z.string().datetime({ offset: true });
const linearScopesSchema = z
  .union([z.array(z.string().min(1).max(64)).max(50), z.string().max(500)])
  .optional();
const linearStateTypeSchema = z.enum(["backlog", "unstarted", "started", "completed", "canceled"]);

export const linearSeedStateSchema = z.object({
  clock: linearDatetimeSchema.default("2026-07-21T00:00:00.000Z"),
  defaultSid: z.string().min(1).max(128).default("standalone"),
  baseUrl: z.string().url().default("http://127.0.0.1:3337"),
  strictScopes: z.boolean().default(false),
  organization: z
    .object({
      id: linearIdSchema.optional(),
      name: z.string().min(1).max(200).optional(),
      urlKey: z.string().min(1).max(100).optional(),
    })
    .optional(),
  users: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        email: linearEmailSchema,
        name: z.string().min(1).max(200).optional(),
        displayName: z.string().min(1).max(200).optional(),
        avatarUrl: z.string().url().nullable().optional(),
        active: z.boolean().default(true),
        admin: z.boolean().default(false),
        app: z.boolean().default(false),
      }),
    )
    .max(500)
    .default([]),
  teams: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        key: z.string().min(1).max(20),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).nullable().optional(),
        private: z.boolean().default(false),
        states: z
          .array(
            z.object({
              id: linearIdSchema.optional(),
              name: z.string().min(1).max(100),
              type: linearStateTypeSchema.optional(),
              position: z.number().int().nonnegative().optional(),
            }),
          )
          .max(50)
          .optional(),
      }),
    )
    .max(50)
    .default([]),
  labels: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        name: z.string().min(1).max(100),
        color: z.string().max(32).optional(),
        description: z.string().max(2000).nullable().optional(),
        team: z.string().min(1).max(128).optional(),
      }),
    )
    .max(500)
    .default([]),
  projects: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        name: z.string().min(1).max(200),
        description: z.string().max(10_000).nullable().optional(),
        state: z.enum(["planned", "started", "completed", "canceled"]).default("planned"),
        team: z.string().min(1).max(128).optional(),
      }),
    )
    .max(200)
    .default([]),
  cycles: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        team: z.string().min(1).max(128),
        name: z.string().min(1).max(200),
        number: z.number().int().positive().optional(),
        startsAt: linearDatetimeSchema.nullable().optional(),
        endsAt: linearDatetimeSchema.nullable().optional(),
      }),
    )
    .max(200)
    .default([]),
  issues: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        team: z.string().min(1).max(128),
        title: z.string().min(1).max(512),
        description: z.string().max(65_536).nullable().optional(),
        priority: z
          .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
          .default(0),
        state: z.string().min(1).max(128).optional(),
        assignee: z.string().min(1).max(200).optional(),
        creator: z.string().min(1).max(200).optional(),
        delegate: z.string().min(1).max(200).optional(),
        project: z.string().min(1).max(200).optional(),
        cycle: z.string().min(1).max(200).optional(),
        parent: z.string().min(1).max(200).optional(),
        estimate: z.number().int().nonnegative().nullable().optional(),
        labels: z.array(z.string().min(1).max(100)).max(50).default([]),
        dueDate: z.string().max(32).nullable().optional(),
        createdAt: linearDatetimeSchema.optional(),
        updatedAt: linearDatetimeSchema.optional(),
      }),
    )
    .max(5000)
    .default([]),
  comments: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        issue: z.string().min(1).max(128),
        body: z.string().min(1).max(65_536),
        parent: z.string().min(1).max(128).optional(),
        user: z.string().min(1).max(200).optional(),
        createdAt: linearDatetimeSchema.optional(),
      }),
    )
    .max(20_000)
    .default([]),
  documents: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        title: z.string().min(1).max(512),
        content: z.string().max(65_536).nullable().optional(),
        slug: z.string().min(1).max(200).optional(),
        project: z.string().min(1).max(200).optional(),
        team: z.string().min(1).max(128).optional(),
        issue: z.string().min(1).max(200).optional(),
        cycle: z.string().min(1).max(200).optional(),
        icon: z.string().max(64).nullable().optional(),
        color: z.string().max(32).nullable().optional(),
        creator: z.string().min(1).max(200).optional(),
        createdAt: linearDatetimeSchema.optional(),
        updatedAt: linearDatetimeSchema.optional(),
      }),
    )
    .max(500)
    .default([]),
  oauthApps: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        clientId: z.string().min(1).max(200),
        clientSecret: z.string().min(1).max(500),
        name: z.string().min(1).max(200),
        redirectUris: z.array(z.string().url()).min(1).max(20),
        scopes: linearScopesSchema,
        actor: z.enum(["user", "app"]).default("user"),
        assignable: z.boolean().default(false),
        mentionable: z.boolean().default(false),
        appUserId: z.string().min(1).max(128).nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
  tokens: z
    .array(
      z.object({
        token: z.string().min(1).max(500),
        type: z.enum(["personal", "oauth_access", "client_credentials"]).default("personal"),
        user: z.string().min(1).max(200).optional(),
        app: z.string().min(1).max(200).optional(),
        scopes: linearScopesSchema,
        actor: z.enum(["user", "app"]).optional(),
        sid: z.string().min(1).max(128).optional(),
        expiresAt: linearDatetimeSchema.nullable().optional(),
      }),
    )
    .max(50)
    .default([]),
  webhooks: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        label: z.string().min(1).max(200).optional(),
        url: z.string().url(),
        resourceTypes: linearScopesSchema,
        team: z.string().min(1).max(128).optional(),
        allPublicTeams: z.boolean().optional(),
        secret: z.string().max(500).nullable().optional(),
        enabled: z.boolean().default(true),
      }),
    )
    .max(50)
    .default([]),
});
export type LinearSeedState = z.infer<typeof linearSeedStateSchema>;

export const providerScopedSeedStateSchema = z
  .object({
    github: z.object({ seed: githubSeedStateSchema }).optional(),
    stripe: z.object({ seed: stripeSeedStateSchema }).optional(),
    slack: z.object({ seed: slackSeedStateSchema }).optional(),
    gmail: z.object({ seed: gmailSeedStateSchema }).optional(),
    linear: z.object({ seed: linearSeedStateSchema }).optional(),
  })
  .refine(
    (value) => Boolean(value.github || value.stripe || value.slack || value.gmail || value.linear),
    {
      message:
        "seedState must include github.seed, stripe.seed, slack.seed, gmail.seed, linear.seed, or the legacy GitHub seed shape",
    },
  );

// SeedState accepts the legacy GitHub shape and the provider-scoped shape
// used by GitHub + Stripe scenario templates.
export const seedStateSchema = z.union([githubSeedStateSchema, providerScopedSeedStateSchema]);
export type SeedState = z.infer<typeof seedStateSchema>;
