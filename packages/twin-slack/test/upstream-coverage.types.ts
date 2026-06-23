// SPDX-License-Identifier: Apache-2.0
//
// FDRS-477 — upstream-added-field coverage guard (type-only; never run).
// Mirrors twin-github/test/upstream-coverage.types.ts (FDRS-475/476).
//
// File name ends in `.types.ts`, NOT `.test.ts`: it matches the tsconfig
// `test/**/*.ts` include (so `bun run typecheck` checks it) but NOT vitest's
// `*.test.ts` glob (so it is never executed as a test). The build tsconfig
// excludes `test/`, so it never ships.
//
// For each anchored serializer, `<Name>_Allow` is the set of upstream fields
// the twin DELIBERATELY does not emit. Each `AssertNoUncovered<...> = true`
// line fails `tsc` — naming the field — the moment @slack/web-api's official
// type gains a field the serializer neither emits nor lists in its `_Allow`
// union. That forces an explicit cover-or-register decision in the @slack
// bump PR.
//
// NOTE: serializeUserProfile and serializeMessage carry their `satisfies`
// anchor on a literal but return a `Record<string, unknown>` accumulator
// (an open `...profile` spread / imperative icons-merge respectively). Their
// `ReturnType` is therefore `Record<string, unknown>`, so AssertNoUncovered is
// vacuously satisfied for them; the field-name guard for those two comes from
// the `satisfies` clause on their literal, not from the assert below. The
// `_Allow` unions are still recorded for documentation.
//
// EDITING ANY `_Allow` UNION IS A CONSCIOUS FIDELITY DECISION — each entry is a
// field the twin is on record as choosing not to emit.
import type { AssertNoUncovered } from "../src/upstream-types.js";
import type {
  SlackBookmark,
  SlackChannel,
  SlackFileInfo,
  SlackMessage,
  SlackReaction,
  SlackScheduledMessage,
  SlackUser,
  SlackUserProfile,
  SlackWorkspace,
} from "../src/upstream-types.js";
import {
  groupReactions,
  serializeBookmark,
  serializeChannel,
  serializeFile,
  serializeMessage,
  serializeScheduledMessage,
  serializeUser,
  serializeUserProfile,
  serializeWorkspace,
} from "../src/serializers.js";

// Deliberate omissions — editing any union below is a conscious fidelity decision.

type Workspace_Allow =
  | "avatar_base_url" | "discoverable" | "enterprise_domain" | "enterprise_name"
  | "is_verified" | "lob_sales_home_enabled";
const _cov_serializeWorkspace: AssertNoUncovered<SlackWorkspace, ReturnType<typeof serializeWorkspace>, Workspace_Allow> = true;

type UserProfile_Allow =
  | "fields" | "first_name" | "huddle_state" | "huddle_state_expiration_ts"
  | "image_1024" | "image_original" | "is_custom_image" | "last_name" | "phone"
  | "pronouns" | "skype" | "status_emoji_display_info" | "status_emoji_url"
  | "status_text_canonical" | "title";
const _cov_serializeUserProfile: AssertNoUncovered<SlackUserProfile, ReturnType<typeof serializeUserProfile>, UserProfile_Allow> = true;

type User_Allow =
  | "enterprise_user" | "has_2fa" | "is_connector_bot" | "is_invited_user"
  | "is_stranger" | "is_workflow_bot";
const _cov_serializeUser: AssertNoUncovered<SlackUser, ReturnType<typeof serializeUser>, User_Allow> = true;

type Channel_Allow =
  | "connected_limited_team_ids" | "connected_team_ids" | "conversation_host_id"
  | "internal_team_ids" | "is_ext_shared" | "is_global_shared" | "is_moved"
  | "is_non_threadable" | "is_org_default" | "is_org_mandatory" | "is_read_only"
  | "is_thread_only" | "locale" | "pending_connected_team_ids" | "previous_names"
  | "shared_team_ids" | "updated";
const _cov_serializeChannel: AssertNoUncovered<SlackChannel, ReturnType<typeof serializeChannel>, Channel_Allow> = true;

type Message_Allow =
  | "assistant_app_thread" | "client_msg_id" | "display_as_bot" | "files"
  | "inviter" | "is_locked" | "metadata" | "purpose" | "reply_users" | "root"
  | "topic" | "upload" | "x_files";
const _cov_serializeMessage: AssertNoUncovered<SlackMessage, ReturnType<typeof serializeMessage>, Message_Allow> = true;

type Reactions_Allow = "url";
const _cov_groupReactions: AssertNoUncovered<SlackReaction, ReturnType<typeof groupReactions>[number], Reactions_Allow> = true;

type File_Allow =
  | "access" | "alt_txt" | "app_id" | "app_name" | "bot_id" | "can_toggle_canvas_lock"
  | "canvas_printing_enabled" | "canvas_template_mode" | "cc" | "channel_actions_count"
  | "channel_actions_ts" | "converted_pdf" | "deanimate" | "deanimate_gif"
  | "dm_mpdm_users_with_file_access" | "duration_ms" | "edit_link" | "edit_timestamp"
  | "editor" | "editors" | "external_id" | "external_url" | "favorites" | "file_access"
  | "from" | "has_more" | "has_more_shares" | "has_rich_preview" | "headers" | "hls"
  | "hls_embed" | "image_exif_rotation" | "initial_comment" | "is_channel_space"
  | "is_restricted_sharing_enabled" | "is_starred" | "last_editor" | "last_read"
  | "lines" | "lines_more" | "linked_channel_id" | "list_csv_download_url"
  | "list_limits" | "list_metadata" | "media_display_type" | "media_progress"
  | "mp4" | "mp4_low" | "non_owner_editable" | "num_stars" | "org_or_workspace_access"
  | "original_attachment_count" | "original_h" | "original_w" | "pinned_to" | "pjpeg"
  | "plain_text" | "preview" | "preview_highlight" | "preview_is_truncated"
  | "preview_plain_text" | "private_channels_with_file_access_count"
  | "private_file_with_access_count" | "quip_thread_id" | "reactions" | "saved"
  | "sent_to_self" | "shares" | "show_badge" | "simplified_html" | "source_team"
  | "subject" | "subtype" | "team_pref_version_history_enabled" | "teams_shared_with"
  | "template_conversion_ts" | "template_description" | "template_icon"
  | "template_name" | "template_title" | "thumb_1024" | "thumb_1024_gif"
  | "thumb_1024_h" | "thumb_1024_w" | "thumb_160" | "thumb_160_gif" | "thumb_160_h"
  | "thumb_160_w" | "thumb_360" | "thumb_360_gif" | "thumb_360_h" | "thumb_360_w"
  | "thumb_480" | "thumb_480_gif" | "thumb_480_h" | "thumb_480_w" | "thumb_64"
  | "thumb_64_gif" | "thumb_64_h" | "thumb_64_w" | "thumb_720" | "thumb_720_gif"
  | "thumb_720_h" | "thumb_720_w" | "thumb_80" | "thumb_800" | "thumb_800_gif"
  | "thumb_800_h" | "thumb_800_w" | "thumb_80_gif" | "thumb_80_h" | "thumb_80_w"
  | "thumb_960" | "thumb_960_gif" | "thumb_960_h" | "thumb_960_w" | "thumb_gif"
  | "thumb_pdf" | "thumb_pdf_h" | "thumb_pdf_w" | "thumb_tiny" | "thumb_video"
  | "thumb_video_h" | "thumb_video_w" | "title_blocks" | "to" | "transcription"
  | "update_notification" | "updated" | "url_static_preview" | "vtt";
const _cov_serializeFile: AssertNoUncovered<SlackFileInfo, ReturnType<typeof serializeFile>, File_Allow> = true;

type Bookmark_Allow = never;
const _cov_serializeBookmark: AssertNoUncovered<SlackBookmark, ReturnType<typeof serializeBookmark>, Bookmark_Allow> = true;

type ScheduledMessage_Allow = never;
const _cov_serializeScheduledMessage: AssertNoUncovered<SlackScheduledMessage, ReturnType<typeof serializeScheduledMessage>, ScheduledMessage_Allow> = true;

// Reference the consts so noUnusedLocals (if enabled) stays quiet; zero runtime cost.
void [
  _cov_serializeWorkspace,
  _cov_serializeUserProfile,
  _cov_serializeUser,
  _cov_serializeChannel,
  _cov_serializeMessage,
  _cov_groupReactions,
  _cov_serializeFile,
  _cov_serializeBookmark,
  _cov_serializeScheduledMessage,
];
