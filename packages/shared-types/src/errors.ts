// SPDX-License-Identifier: Apache-2.0
//
// shared-types §5 — ERROR ENVELOPE (public REST). The `error.type` enum and the
// wrapping envelope shape. Re-exported through the `@pome-sh/shared-types`
// barrel (index.ts).

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// 5. ERROR ENVELOPE (public REST)
// ─────────────────────────────────────────────────────────────────────────────

export const apiErrorTypeSchema = z.enum([
  "invalid_auth",
  "revoked_key",
  "forbidden",                                 // 403 non-auth permission denial
  "quota_exceeded",
  "validation_failed",
  "not_found",
  "session_expired",                           // distinct from not_found for CLI UX
  "conflict",                                  // 409 (uniqueness, etc.)
  "rate_limited",
  "internal_error",
  "endpoint_not_implemented",
  "downstream_unavailable",
]);
export type ApiErrorType = z.infer<typeof apiErrorTypeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    type: apiErrorTypeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    documentation_url: z.string().url().optional(),
    request_id: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
