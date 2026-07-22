// SPDX-License-Identifier: Apache-2.0
import type { StateDelta } from "@pome-sh/shared-types";
import { slackError, notFound, TwinError } from "../errors.js";
import {
  SLACK_TWIN_HOST,
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
import type { Actor, SlackDomain } from "./slack-domain.js";

// ───────────────────────────────────────────────────────────────────────────
// Auth
// ───────────────────────────────────────────────────────────────────────────

export function authTest(domain: SlackDomain, actor: Actor): Record<string, unknown> {
  const workspace = domain.requireWorkspace();
  const userRow = domain.resolveActorUser(actor);
  return {
    url: `${SLACK_TWIN_HOST}/`,
    team: workspace.name,
    user: userRow.name,
    team_id: workspace.id,
    user_id: userRow.id,
    bot_id: userRow.is_bot ? userRow.id : null,
    is_enterprise_install: false,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Team
// ───────────────────────────────────────────────────────────────────────────

export function teamInfo(domain: SlackDomain, args: { team?: string }): Record<string, unknown> {
  void args;
  return { team: serializeWorkspace(domain.requireWorkspace()) };
}

