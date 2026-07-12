// SPDX-License-Identifier: Apache-2.0
//
// shared-types §1 — IDENTITY. Users, teams, memberships, invites, API keys.
// Re-exported through the `@pome-sh/shared-types` barrel (index.ts).

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// 1. IDENTITY
// ─────────────────────────────────────────────────────────────────────────────

export const userSchema = z.object({
  id: z.string(),                              // usr_<nanoid> (text, not uuid; per /plan-eng-review L7)
  clerk_user_id: z.string(),                   // Clerk user ID (`user_*`)
  email: z.string().email(),
  display_name: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type User = z.infer<typeof userSchema>;

// FDRS-613: reconciled to pome-cloud /v1 wire truth — `hobby` and `team` were
// added cloud-side for the launch pricing tiers; adopted here so a cloud-issued
// MeResponse / UsageResponse (plan_tier) parses under the twins schema.
export const planTierSchema = z.enum([
  "free",
  "hobby",
  "pro",
  "team",
  "self_host_annual",
  "enterprise",
]);
export type PlanTier = z.infer<typeof planTierSchema>;

export const teamSchema = z.object({
  id: z.string(),                              // tm_<nanoid>
  slug: z.string(),                            // /dashboard/[teamSlug]/...
  name: z.string(),
  plan_tier: planTierSchema,
  stripe_customer_id: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamRoleSchema = z.enum(["owner", "admin", "member"]);
export type TeamRole = z.infer<typeof teamRoleSchema>;

export const teamMemberSchema = z.object({
  team_id: z.string(),
  user_id: z.string(),
  role: teamRoleSchema,
  invited_at: z.string().datetime(),
  accepted_at: z.string().datetime().nullable(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

// Public invite shape — token is NEVER returned in API responses. The plaintext
// token is delivered exactly once via `createInviteResponseSchema.invite_url`
// (which embeds it as a path segment). Server stores only sha256(token) in
// `team_invites.token_hash`.
export const teamInviteSchema = z.object({
  id: z.string(),                              // inv_<nanoid>
  team_id: z.string(),
  email: z.string().email(),
  role: teamRoleSchema,
  invited_by: z.string(),                      // user_id
  expires_at: z.string().datetime(),
  accepted_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});
export type TeamInvite = z.infer<typeof teamInviteSchema>;

export const apiKeySchema = z.object({
  id: z.string(),                              // pme_<short> public prefix; hashed_key NEVER appears in API responses (kept server-side only)
  team_id: z.string(),
  name: z.string(),
  created_by: z.string(),                      // user_id
  last_used_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

// One-time response shape — full key string is only in the create-response, never persisted.
export const apiKeyCreatedSchema = apiKeySchema.extend({
  full_key: z.string(),                        // pme_<full> — show once, then redact
});
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;
