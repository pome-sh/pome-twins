// SPDX-License-Identifier: Apache-2.0
import type { TwinDatabase } from "@pome-sh/sdk";

export type { RecorderEvent } from "@pome-sh/shared-types";

// The engine's driver wrapper is the only database surface a twin sees
// (F-681/F-683): prepare/exec/pragma/transaction/close.
export type SlackTwinDatabase = TwinDatabase;

export type SeedTeam = {
  id?: string;
  name?: string;
  domain?: string;
};

export type SeedUser = {
  id?: string;
  name: string;
  real_name?: string;
  email?: string;
  is_bot?: boolean;
  is_admin?: boolean;
  tz?: string;
  profile?: Record<string, unknown>;
};

export type SeedReaction = { name: string; user: string };

export type SeedMessage = {
  ts?: string;
  user: string;
  text: string;
  thread_ts?: string;
  reactions?: SeedReaction[];
};

export type SeedChannel = {
  id?: string;
  name: string;
  is_private?: boolean;
  topic?: string;
  purpose?: string;
  creator?: string;
  members?: string[];
  messages?: SeedMessage[];
};

export type SeedEmoji = {
  name: string;
  /** Absolute image URL. Ignored when `alias` is set. */
  url?: string;
  /** Alias target name → stored as `alias:<name>`. */
  alias?: string;
};

export type SlackStateSeed = {
  team?: SeedTeam;
  users?: SeedUser[];
  channels?: SeedChannel[];
  emoji?: SeedEmoji[];
};

export type WorkspaceRow = {
  id: string;
  name: string;
  domain: string;
  url: string;
  enterprise_id: string | null;
  created_at: string;
  entity_counter: number;
};

export type UserRow = {
  id: string;
  team_id: string;
  name: string;
  real_name: string;
  display_name: string;
  email: string | null;
  is_bot: 0 | 1;
  is_admin: 0 | 1;
  deleted: 0 | 1;
  tz: string;
  profile_json: string;
  created_at: string;
  updated_at: string;
};

export type ChannelRow = {
  id: string;
  team_id: string;
  name: string;
  is_channel: 0 | 1;
  is_group: 0 | 1;
  is_im: 0 | 1;
  is_mpim: 0 | 1;
  is_private: 0 | 1;
  is_archived: 0 | 1;
  topic: string;
  purpose: string;
  creator: string;
  created_at: string;
  ts_counter: number;
  dm_signature: string | null;
};

export type ChannelMemberRow = {
  channel_id: string;
  user_id: string;
  joined_at: string;
  last_read: string;
};

export type MessageRow = {
  channel_id: string;
  ts: string;
  user_id: string;
  text: string;
  subtype: string | null;
  thread_ts: string | null;
  reply_count: number;
  reply_users_count: number;
  latest_reply: string | null;
  edited_user_id: string | null;
  edited_ts: string | null;
  blocks_json: string;
  attachments_json: string;
  bot_id: string | null;
  app_id: string | null;
  username: string | null;
  icon_url: string | null;
  icon_emoji: string | null;
};

export type ReactionRow = {
  channel_id: string;
  message_ts: string;
  name: string;
  user_id: string;
  added_at: string;
};

export type PinRow = {
  channel_id: string;
  message_ts: string;
  pinned_by: string;
  pinned_at: string;
};

export type FileRow = {
  id: string;
  team_id: string;
  user_id: string;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private: string;
  channels_json: string;
  deleted: 0 | 1;
  content: string | null;
  created_at: string;
};

export type BookmarkRow = {
  id: string;
  channel_id: string;
  title: string;
  link: string;
  emoji: string | null;
  type: string;
  created_by: string;
  created_at: string;
};

export type ScheduledMessageRow = {
  id: string;
  channel_id: string;
  user_id: string;
  text: string;
  thread_ts: string | null;
  post_at: number;
  date_created: number;
  blocks_json: string;
};

export type CanvasRow = {
  id: string;
  team_id: string;
  title: string;
  markdown: string;
  channel_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type EmojiRow = {
  team_id: string;
  name: string;
  value: string;
};

