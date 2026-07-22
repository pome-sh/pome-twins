// SPDX-License-Identifier: Apache-2.0
import type { StateDelta } from "@pome-sh/shared-types";
import { slackError, notFound, TwinError } from "../errors.js";
import {
  groupReactions,
  serializeBookmark,
  serializeChannel,
  serializeFile,
  serializeMessage,
  serializePin,
  serializeScheduledMessage,
  serializeUser,
  serializeUserProfile,
  serializeWorkspace,
} from "../serializers.js";
import type {
  BookmarkRow,
  ChannelMemberRow,
  ChannelRow,
  FileRow,
  MessageRow,
  PinRow,
  ReactionRow,
  ScheduledMessageRow,
  SlackTwinDatabase,
  UserRow,
  WorkspaceRow,
} from "../types.js";
import { cursorDecode, cursorEncode, nowIso, nowUnix, padTsCounter, tsBaseSeconds } from "../util.js";
import type { Actor, DeltaHook, SlackDomain } from "./slack-domain.js";
import { NOOP } from "./slack-domain.js";
import { clampLimit, safeParseJson } from "./helpers.js";

// ───────────────────────────────────────────────────────────────────────────
// Users
// ───────────────────────────────────────────────────────────────────────────

export function usersList(domain: SlackDomain, args: { cursor?: string; limit?: number; include_locale?: boolean; team_id?: string }): Record<string, unknown> {
  const workspace = domain.requireWorkspace();
  const offset = cursorDecode(args.cursor ?? null)?.offset ?? 0;
  const limit = clampLimit(args.limit, 1000, 100);
  const rows = domain.db
    .prepare(`SELECT * FROM users WHERE team_id = ? ORDER BY id LIMIT ? OFFSET ?`)
    .all(workspace.id, limit + 1, offset) as UserRow[];
  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  return {
    // users.list embeds each user's profile WITHOUT `email` — real Slack only
    // returns the email on the single-user reads (FDRS-473 Kind B).
    members: slice.map((row) => serializeUser(row, { include_locale: args.include_locale, omitProfileEmail: true })),
    cache_ts: nowUnix(),
    response_metadata: {
      next_cursor: hasMore ? cursorEncode({ offset: offset + slice.length }) : "",
    },
  };
}


export function usersInfo(domain: SlackDomain, args: { user: string; include_locale?: boolean }): Record<string, unknown> {
  const user = domain.resolveUser(args.user);
  if (!user) slackError("user_not_found", 404);
  return { user: serializeUser(user!, { include_locale: args.include_locale }) };
}


export function usersLookupByEmail(domain: SlackDomain, args: { email: string }): Record<string, unknown> {
  if (!args.email) slackError("users_not_found", 400);
  const workspace = domain.requireWorkspace();
  const user = domain.db
    .prepare(`SELECT * FROM users WHERE team_id = ? AND email = ?`)
    .get(workspace.id, args.email) as UserRow | undefined;
  if (!user) slackError("users_not_found", 404);
  return { user: serializeUser(user!) };
}


export function usersProfileGet(domain: SlackDomain, args: { user?: string; include_labels?: boolean }, actor: Actor): Record<string, unknown> {
  const target = args.user ? domain.resolveUser(args.user) : domain.resolveActorUser(actor);
  if (!target) slackError("user_not_found", 404);
  // users.profile.get returns the bare profile WITHOUT `team` — real Slack omits
  // it on this endpoint (it carries it in the embedded user.profile elsewhere)
  // (FDRS-473 Kind B).
  return { profile: serializeUserProfile(target!, { omitTeam: true }) };
}


export function usersProfileSet(domain: SlackDomain, args: { user?: string; profile?: string; name?: string; value?: string }, actor: Actor, onDelta: DeltaHook = NOOP): Record<string, unknown> {
  const target = args.user ? domain.resolveUser(args.user) : domain.resolveActorUser(actor);
  if (!target) slackError("user_not_found", 404);
  const acting = domain.resolveActorUser(actor);
  if (target!.id !== acting.id && !acting.is_admin) slackError("cant_set_profile_for_other_user", 403);
  const out = domain.db.transaction(() => {
    const before = domain.db.prepare(`SELECT * FROM users WHERE id = ?`).get(target!.id) as UserRow;
    let profile = safeParseJson(before.profile_json);
    if (args.profile) {
      const incoming = safeParseJson(args.profile);
      profile = { ...(profile as object), ...(incoming as object) };
    } else if (args.name) {
      profile = { ...(profile as object), [args.name]: args.value ?? "" };
    }
    domain.db
      .prepare(`UPDATE users SET profile_json = ?, real_name = COALESCE((SELECT json_extract(?, '$.real_name')), real_name), updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(profile), JSON.stringify(profile), nowIso(), target!.id);
    const after = domain.db.prepare(`SELECT * FROM users WHERE id = ?`).get(target!.id) as UserRow;
    onDelta({ before, after });
    // users.profile.set echoes the bare profile, same shape as users.profile.get
    // (no `team`) — FDRS-473 Kind B.
    return { profile: serializeUserProfile(after, { omitTeam: true }) };
  })();
  return out;
}

