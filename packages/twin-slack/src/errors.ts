// SPDX-License-Identifier: Apache-2.0

// TwinError carries an HTTP status + Slack-shaped error code. The twin's
// errorEnvelope hook (`twin.ts`, rendered by the engine's recorder) translates
// this into `{ok:false, error:<code>}`. Common codes pulled from real Slack docs:
//   - channel_not_found, user_not_found, message_not_found
//   - not_in_channel, already_in_channel, cant_kick_self, cant_leave_general
//   - is_archived, name_taken, restricted_action
//   - invalid_auth, not_authed, missing_scope
//   - cant_delete_message, cant_update_message, edit_window_closed
//   - invalid_arguments, invalid_array_arg, invalid_cursor
//   - rate_limited, internal_error
export class TwinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly extra?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function slackError(code: string, status = 400, extra?: Record<string, unknown>): never {
  throw new TwinError(code, status, code, extra);
}

export function notFound(code = "not_found"): never {
  throw new TwinError(code, 404, code);
}

export function validationFailed(code = "invalid_arguments", extra?: Record<string, unknown>): never {
  throw new TwinError(code, 400, code, extra);
}

export function buildSlackErrorPayload(err: TwinError) {
  return {
    ok: false,
    error: err.code,
    ...(err.extra ?? {}),
  };
}

export function isSqliteConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code ?? "";
  return code.startsWith("SQLITE_CONSTRAINT");
}

/** Map SQLite UNIQUE violations to Slack-shaped domain errors for concurrent requests. */
export function twinErrorFromSqliteConstraint(method: string, err: unknown): TwinError | null {
  if (!isSqliteConstraintError(err)) return null;
  const message = err instanceof Error ? err.message : String(err);
  if (method === "conversations.create" || message.includes("channels_name_idx")) {
    return new TwinError("name_taken", 409, "name_taken");
  }
  if (method.startsWith("reactions.") || message.includes("reactions")) {
    return new TwinError("already_reacted", 400, "already_reacted");
  }
  if (method.startsWith("pins.") || message.includes("pins")) {
    return new TwinError("already_pinned", 400, "already_pinned");
  }
  return new TwinError("internal_error", 500, "internal_error", { warning: message });
}
