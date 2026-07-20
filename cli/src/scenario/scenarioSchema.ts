// SPDX-License-Identifier: Apache-2.0
import { seedSchema as githubSeedStateSchema } from "@pome-sh/twin-github";
import { gmailSeedSchema as gmailSeedStateSchema } from "@pome-sh/twin-gmail";
// Criterion kinds are owned by the published contract. The markdown marker
// grammar is `[code]`/`[model]` (F-778); `criterionSchema`'s tolerant input
// (legacy `D`/`P` enum values) exists only for 0.3.0-era persisted artifacts,
// never for scenario markdown. The former local criterion-kind fork is
// retired here (M6 — one published contract).
import { criterionSchema } from "@pome-sh/shared-types";
import { z } from "zod";

export { criterionSchema };

export const scenarioConfigSchema = z.object({
  twins: z.array(z.string()).default(["github"]),
  timeout: z.number().int().positive().default(60),
  runs: z.number().int().positive().default(1),
  passThreshold: z.number().min(0).max(100).default(100)
});

// FDRS-339: scenario-level failure injection. Mirrors the packaged
// twin-stripe `failureInjectionRuleSchema` without importing it into the
// parser, so scenario validation stays decoupled from twin boot/runtime code.
export const stripeFailureInjectionRuleSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  attempt: z.number().int().positive(),
  mode: z.enum(["before_handler", "after_handler"]).default("after_handler"),
  status: z.number().int().min(100).max(599),
  body: z.unknown()
});

// `.strict()` at the top level: unknown keys (notably the legacy
// `stripe: { seed: ... }` wrapper rejected by FDRS-365) fail parsing loudly
// instead of silently being stripped to an empty seed.
export const stripeSeedStateSchema = z
  .object({
    api_keys: z
      .array(
        z.object({
          key: z.string().min(1).default("sk_test_pome_default"),
          sid: z.string().min(1).default("default"),
          account_id: z.string().min(1).optional()
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
    failure_injection: z.array(stripeFailureInjectionRuleSchema).default([])
  })
  .strict();

// FDRS-529: Slack seed shape (`{ team?, users: [...], channels: [...] }`).
// Kept LOCAL and permissive (arrays of records) for the same reason the Stripe
// schema is — the scenario parser shouldn't take a structural dep on twin
// internals; the vendored `cli/src/twin-slack` `parseSeed` does the strict,
// regex-level validation at boot. `.strict()` is load-bearing: it makes this
// arm reject any object carrying a GitHub (`repositories`) or Stripe
// (`api_keys`, `charges`, …) discriminator, so placing it FIRST in the union
// (below) can't greedily mis-match a non-Slack seed.
export const slackSeedStateSchema = z
  .object({
    team: z.record(z.string(), z.unknown()).optional(),
    users: z.array(z.record(z.string(), z.unknown())).default([]),
    channels: z.array(z.record(z.string(), z.unknown())).default([])
  })
  .strict();

// FDRS-365 [DECISION 2026-05-12]: scenario seeds are FLAT per twin.
// GitHub scenarios use the GitHub seed shape (`{ repositories: [...] }`),
// Stripe scenarios use the Stripe seed shape (`{ api_keys: [...], ... }`),
// Slack scenarios use the Slack seed shape (`{ users, channels, ... }`).
// Multi-twin scenarios are not a current requirement; the wrapped
// `{ <twin>: { seed: ... } }` form was rejected here to keep one canonical
// shape that twin parsers already speak natively. parseScenario disambiguates
// the union by `config.twins`.
//
// Slack arm is FIRST because it is the only `.strict()` arm: a GitHub/Stripe
// seed carries keys it rejects, so it never mis-matches them; while a Slack
// seed would otherwise be silently key-stripped by the non-strict GitHub arm.
export const seedStateSchema = z.union([
  gmailSeedStateSchema,
  slackSeedStateSchema,
  githubSeedStateSchema,
  stripeSeedStateSchema
]);

// Multi-twin (M3): a per-twin seed envelope `{ <twin>: <flat seed> }`, produced
// ONLY for scenarios whose `config.twins` has >1 entry (the envelope-iff-multi-twin
// rule, decided from `twins` alone — never by sniffing the seed shape). Each value
// is one twin's flat seed, the same shapes `seedStateSchema` unions. Single-twin
// scenarios keep the flat shape byte-identical. parseScenario builds and validates
// the envelope value-by-value with each twin's own schema; this record is the outer
// shape scenarioSchema re-validates against.
export const seedEnvelopeSchema = z.record(z.string(), seedStateSchema);

export const scenarioSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  setup: z.string().default(""),
  prompt: z.string().min(1),
  expectedBehavior: z.string().default(""),
  criteria: z.array(criterionSchema).min(1),
  config: scenarioConfigSchema,
  // Flat single-twin seed OR the multi-twin per-twin envelope. Flat is tried
  // first so single-twin seeds match their strict arms; the envelope only
  // matches when the flat union can't (its keys are twin ids, not seed fields).
  seedState: z.union([seedStateSchema, seedEnvelopeSchema])
});

export type Criterion = z.infer<typeof criterionSchema>;
export type ScenarioConfig = z.infer<typeof scenarioConfigSchema>;
export type GithubSeedState = z.infer<typeof githubSeedStateSchema>;
export type StripeSeedState = z.infer<typeof stripeSeedStateSchema>;
export type SlackSeedState = z.infer<typeof slackSeedStateSchema>;
export type GmailSeedState = z.infer<typeof gmailSeedStateSchema>;
export type StripeFailureInjectionRule = z.infer<typeof stripeFailureInjectionRuleSchema>;
export type SeedState = z.infer<typeof seedStateSchema>;
export type SeedEnvelope = z.infer<typeof seedEnvelopeSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
