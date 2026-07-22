// SPDX-License-Identifier: Apache-2.0
import type { ToolCallContext } from "@pome-sh/sdk";
import type { SessionValue } from "@pome-sh/sdk/server";
import type { ActorContext } from "./domain/index.js";
import { DEFAULT_LINEAR_EMAIL } from "./types.js";

/** Actor claims from a JWT/session for GraphQL and MCP. */
export function actorFromSession(session?: SessionValue): ActorContext {
  return {
    userId: typeof session?.linear_user_id === "string" ? session.linear_user_id : undefined,
    email:
      typeof session?.linear_email === "string" ? session.linear_email : DEFAULT_LINEAR_EMAIL,
    scopes: Array.isArray(session?.scopes) ? (session.scopes as string[]) : undefined,
  };
}

/** Actor claims from an MCP tool-call context. */
export function actorFromToolContext(ctx: ToolCallContext): ActorContext {
  return actorFromSession(ctx.session);
}
