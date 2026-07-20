// SPDX-License-Identifier: Apache-2.0
//
// shared-types §2 — SESSIONS. Mounted-twin allowlist, session state machine,
// internal DB row + public API response shapes. Re-exported through the
// `@pome-sh/shared-types` barrel (index.ts).

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// 2. SESSIONS
// ─────────────────────────────────────────────────────────────────────────────

// Mounted twin set — the cloud control plane's allowlist for create-session.
// V1 ships GitHub only end-to-end; Stripe/Slack are scaffolded in the OSS repo
// and reachable through the multi-twin runtime. Distinct from `KNOWN_TWIN_IDS`
// (re-exported from `./recorder-events.ts`) which serves dashboard-rendering
// pattern-matching for arbitrary `RecorderEvent.twin` values. Mirrored from
// pome-cloud shared-types (FDRS-613).
export const MOUNTED_TWINS = ["github", "stripe", "slack", "gmail"] as const;

export const sessionStateSchema = z.enum([
  "provisioning",
  "ready",
  "running",
  "done",
  "expired",
  "failed",
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

// Internal DB row shape — includes pod_id and api_key_id which are NOT exposed publicly.
//
// Multi-twin (M3): `twins[]` is the new authoritative field. `twin_type` is kept
// populated as legacy = `twins[0]` for ≥1 OSS CLI release. FDRS-613: `twins`
// adopted from pome-cloud so a cloud-issued Session / SessionPublic parses here.
export const sessionSchema = z.object({
  id: z.string(),                              // ses_<nanoid>
  team_id: z.string(),
  api_key_id: z.string().nullable(),           // null if dashboard-launched
  twin_type: z.string(),                       // legacy: equals twins[0] in M3+; kept for one CLI release
  twins: z.array(z.string()).min(1),           // M3: authoritative list of mounted twins for this session
  state: sessionStateSchema,
  twin_url: z.string().url().nullable(),       // populated when state='ready'
  pod_id: z.string().nullable(),               // INTERNAL: which pool pod served — never on public API responses
  created_at: z.string().datetime(),
  ready_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime(),           // TTL, default created_at + 30min
  closed_at: z.string().datetime().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

// Public API response shape — strips internal infrastructure fields per /plan-eng-review.
// `GET /v1/sessions/{id}` and `GET /v1/sessions` return SessionPublic.
// Internal orchestrator endpoints use the full Session shape.
export const sessionPublicSchema = sessionSchema.omit({
  pod_id: true,
  api_key_id: true,
});
export type SessionPublic = z.infer<typeof sessionPublicSchema>;
