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
});
export type SlackSeedState = z.infer<typeof slackSeedStateSchema>;

export const providerScopedSeedStateSchema = z
  .object({
    github: z.object({ seed: githubSeedStateSchema }).optional(),
    stripe: z.object({ seed: stripeSeedStateSchema }).optional(),
    slack: z.object({ seed: slackSeedStateSchema }).optional(),
  })
  .refine((value) => Boolean(value.github || value.stripe || value.slack), {
    message: "seedState must include github.seed, stripe.seed, slack.seed, or the legacy GitHub seed shape",
  });

// SeedState accepts the legacy GitHub shape and the provider-scoped shape
// used by GitHub + Stripe scenario templates.
export const seedStateSchema = z.union([githubSeedStateSchema, providerScopedSeedStateSchema]);
export type SeedState = z.infer<typeof seedStateSchema>;
