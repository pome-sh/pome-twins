// SPDX-License-Identifier: Apache-2.0
import type {
  BookmarkRow,
  ChannelRow,
  FileRow,
  MessageRow,
  PinRow,
  ReactionRow,
  ScheduledMessageRow,
  UserRow,
  WorkspaceRow,
} from "./types.js";
import type {
  DeepPartial,
  SlackBookmark,
  SlackChannel,
  SlackFileInfo,
  SlackMessage,
  SlackReaction,
  SlackScheduledMessage,
  SlackUser,
  SlackUserProfile,
  SlackWorkspace,
} from "./upstream-types.js";

export const SLACK_TWIN_HOST = "https://pome-twin.slack.com";
export const SLACK_TWIN_FILE_HOST = "https://pome-twin-files.slack.com";

export function slackOk<T extends Record<string, unknown>>(payload: T): { ok: true } & T {
  return { ok: true, ...payload };
}

export function slackError(code: string, extra: Record<string, unknown> = {}): { ok: false; error: string } & Record<string, unknown> {
  return { ok: false, error: code, ...extra };
}

export function serializeWorkspace(row: WorkspaceRow) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    email_domain: row.domain.includes(".") ? row.domain : `${row.domain}.slack.com`,
    icon: {
      image_default: true,
      image_34: `${SLACK_TWIN_HOST}/team_default_v2_0034.png`,
      image_44: `${SLACK_TWIN_HOST}/team_default_v2_0044.png`,
      image_68: `${SLACK_TWIN_HOST}/team_default_v2_0068.png`,
      image_88: `${SLACK_TWIN_HOST}/team_default_v2_0088.png`,
      image_102: `${SLACK_TWIN_HOST}/team_default_v2_0102.png`,
      image_132: `${SLACK_TWIN_HOST}/team_default_v2_0132.png`,
      image_230: `${SLACK_TWIN_HOST}/team_default_v2_0230.png`,
    },
    enterprise_id: row.enterprise_id ?? undefined,
    url: row.url,
  } satisfies DeepPartial<SlackWorkspace>;
}

export function serializeUserProfile(
  row: UserRow,
  // Real Slack varies the profile field set by ENDPOINT (FDRS-473 Kind B):
  //  - users.list embeds the profile WITHOUT `email` (omit it there);
  //  - users.profile.get returns the bare profile WITHOUT `team` (omit it there).
  // users.info / lookupByEmail carry both. The flags let each caller match the
  // real per-endpoint shape instead of the twin over-returning a field real Slack
  // omits (a `field-added` divergence).
  opts: { omitEmail?: boolean; omitTeam?: boolean } = {}
) {
  const profile = safeJson(row.profile_json) as Record<string, unknown>;
  // Static literal is anchored to the upstream Profile shape (FDRS-477). The
  // `...profile` spread and the conditional email/team keys are folded in
  // afterward: `team` is not an upstream Profile field (held out of the
  // satisfies object) and the spread is an open Record (untyped values), so
  // both live on the surrounding `out` accumulator, not the anchored literal.
  const base = {
    avatar_hash: "g000000000",
    status_text: (profile.status_text as string | undefined) ?? "",
    status_emoji: (profile.status_emoji as string | undefined) ?? "",
    status_expiration: (profile.status_expiration as number | undefined) ?? 0,
    real_name: row.real_name,
    display_name: row.display_name || row.real_name || row.name,
    real_name_normalized: row.real_name,
    display_name_normalized: row.display_name || row.real_name || row.name,
    image_24: `${SLACK_TWIN_HOST}/avatars/${row.id}_24.png`,
    image_32: `${SLACK_TWIN_HOST}/avatars/${row.id}_32.png`,
    image_48: `${SLACK_TWIN_HOST}/avatars/${row.id}_48.png`,
    image_72: `${SLACK_TWIN_HOST}/avatars/${row.id}_72.png`,
    image_192: `${SLACK_TWIN_HOST}/avatars/${row.id}_192.png`,
    image_512: `${SLACK_TWIN_HOST}/avatars/${row.id}_512.png`,
  } satisfies DeepPartial<SlackUserProfile>;
  const out: Record<string, unknown> = {
    ...base,
    ...profile,
  };
  // email/team are set AFTER the profile_json spread (so the row's canonical value
  // wins), then dropped when the endpoint omits them.
  if (opts.omitEmail) {
    delete out.email;
  } else if (row.email != null && out.email === undefined) {
    out.email = row.email;
  }
  if (opts.omitTeam) {
    delete out.team;
  } else if (out.team === undefined) {
    out.team = row.team_id;
  }
  return out;
}

export function serializeUser(row: UserRow, opts: { include_locale?: boolean; omitProfileEmail?: boolean } = {}) {
  return {
    id: row.id,
    team_id: row.team_id,
    name: row.name,
    deleted: Boolean(row.deleted),
    color: "9f69e7",
    real_name: row.real_name,
    tz: row.tz,
    tz_label: row.tz.replace(/_/g, " "),
    tz_offset: 0,
    // The embedded profile carries `team` (both users.list and users.info) but
    // OMITS `email` on users.list — real Slack only returns the email on the
    // single-user reads (users.info / lookupByEmail), not in the list envelope
    // (FDRS-473 Kind B). `omitProfileEmail` is set by the users.list caller.
    // serializeUserProfile returns Record<string, unknown> (its own `...profile`
    // spread is an open record); cast to the upstream Profile shape so the parent
    // `satisfies` stays exact without re-anchoring the nested record here.
    profile: serializeUserProfile(row, { omitEmail: opts.omitProfileEmail }) as SlackUser["profile"],
    is_admin: Boolean(row.is_admin),
    is_owner: Boolean(row.is_admin),
    is_primary_owner: row.id === "U_PRIMARY",
    is_restricted: false,
    is_ultra_restricted: false,
    is_bot: Boolean(row.is_bot),
    is_app_user: false,
    updated: tsToUnix(row.updated_at),
    is_email_confirmed: Boolean(row.email),
    who_can_share_contact_card: "EVERYONE",
    ...(opts.include_locale ? { locale: "en-US" } : {}),
  } satisfies DeepPartial<SlackUser>;
}

export function serializeChannel(
  row: ChannelRow,
  opts: {
    include_members?: string[];
    num_members?: number;
    last_read?: string;
    is_member?: boolean;
  } = {}
) {
  const created = tsToUnix(row.created_at);
  const isIm = Boolean(row.is_im);
  const isMpim = Boolean(row.is_mpim);
  const isPrivate = Boolean(row.is_private || row.is_group);
  // `parent_conversation` (always null) is a twin-only key the upstream Channel
  // type lacks, so it is held out of the satisfies anchor and spread back below
  // (mirrors twin-github repoJson parentRef). `members` (conditional, below) is
  // likewise twin-only and spread back outside the anchor.
  const out: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    name_normalized: row.name,
    is_channel: Boolean(row.is_channel) && !isIm && !isMpim,
    is_group: Boolean(row.is_group) || (isPrivate && !isIm && !isMpim),
    is_im: isIm,
    is_mpim: isMpim,
    is_private: isPrivate,
    is_archived: Boolean(row.is_archived),
    is_general: row.name === "general",
    is_shared: false,
    is_org_shared: false,
    is_pending_ext_shared: false,
    pending_shared: [],
    context_team_id: row.team_id,
    creator: row.creator,
    created,
    unlinked: 0,
    topic: {
      value: row.topic,
      creator: row.creator,
      last_set: created,
    },
    purpose: {
      value: row.purpose,
      creator: row.creator,
      last_set: created,
    },
  } satisfies DeepPartial<SlackChannel>;
  out.parent_conversation = null;
  // Real Slack OMITS `previous_names` on conversations.info for a channel that was
  // never renamed (it only carries the key once a rename history exists). The twin
  // models no rename history, so it omits the key entirely rather than emitting an
  // empty array — a faithful subset, not an over-returned twin-only field that
  // diffs as `field-added` against real Slack (FDRS-473 Kind B).
  if (opts.num_members !== undefined) out.num_members = opts.num_members;
  if (opts.is_member !== undefined) out.is_member = opts.is_member;
  if (opts.last_read !== undefined) out.last_read = opts.last_read;
  if (opts.include_members) out.members = opts.include_members;
  return out;
}

export function serializeMessage(
  row: MessageRow,
  opts: { reactions?: ReactionRow[]; include_team?: string; permalink?: string; parent_user_id?: string } = {}
) {
  // Bot identity: prefer persisted column on the message row (set on INSERT
  // when author.is_bot). Fall back to the legacy U*/B* prefix heuristic for
  // rows inserted by older code paths that pre-date the bot_id column.
  const botId = row.bot_id ?? (row.user_id.startsWith("B") ? row.user_id : null);
  const blocks = safeJsonArray(row.blocks_json);
  const attachments = safeJsonArray(row.attachments_json);
  // Every conditional key is folded in via a conditional spread so the whole
  // literal stays under the `satisfies` anchor. `permalink` is the only
  // emitted key absent from the upstream MessageElement type (an @slack/web-api
  // conversations.history typegen gap, not a twin-only invention), so it is held
  // out of the anchor and spread back on the Record accumulator below — mirrors
  // the twin-github repoJson parentRef hold-out.
  const out: Record<string, unknown> = {
    type: "message",
    user: row.user_id,
    text: row.text,
    ts: row.ts,
    ...(row.subtype ? { subtype: row.subtype } : {}),
    ...(row.thread_ts
      ? {
          thread_ts: row.thread_ts,
          // parent_user_id is the THREAD PARENT's author, not this row's author.
          ...(opts.parent_user_id ? { parent_user_id: opts.parent_user_id } : {}),
        }
      : {}),
    ...(row.reply_count > 0
      ? {
          reply_count: row.reply_count,
          reply_users_count: row.reply_users_count,
          // row.latest_reply is `string | null`; upstream is `string | undefined`.
          // Cast to the upstream field type — runtime value is unchanged.
          latest_reply: row.latest_reply as SlackMessage["latest_reply"],
          subscribed: false,
        }
      : {}),
    ...(row.edited_user_id && row.edited_ts
      ? { edited: { user: row.edited_user_id, ts: row.edited_ts } }
      : {}),
    // safeJsonArray returns unknown[]; cast to the upstream field types so the
    // anchor stays exact (mirrors twin-github `as Upstream["field"]`).
    ...(blocks.length > 0 ? { blocks: blocks as SlackMessage["blocks"] } : {}),
    ...(attachments.length > 0 ? { attachments: attachments as SlackMessage["attachments"] } : {}),
    ...(opts.reactions && opts.reactions.length > 0
      ? { reactions: groupReactions(opts.reactions) }
      : {}),
    ...(opts.include_team ? { team: opts.include_team } : {}),
    ...(botId
      ? {
          bot_id: botId,
          ...(row.app_id ? { app_id: row.app_id } : {}),
          bot_profile: {
            id: botId,
            deleted: false,
            name: row.username ?? botId,
            updated: tsToUnix(row.ts),
            app_id: row.app_id ?? "A_POME",
            icons: row.icon_url
              ? { image_36: row.icon_url, image_48: row.icon_url, image_72: row.icon_url }
              : {
                  image_36: `${SLACK_TWIN_HOST}/avatars/${botId}_36.png`,
                  image_48: `${SLACK_TWIN_HOST}/avatars/${botId}_48.png`,
                  image_72: `${SLACK_TWIN_HOST}/avatars/${botId}_72.png`,
                },
            team_id: opts.include_team ?? "",
          },
        }
      : {}),
    ...(row.username ? { username: row.username } : {}),
  } satisfies DeepPartial<SlackMessage>;
  if (opts.permalink) out.permalink = opts.permalink;
  if (row.icon_emoji) out.icons = { ...(out.icons ?? {}), emoji: row.icon_emoji };
  if (row.icon_url) out.icons = { ...(out.icons ?? {}), image_64: row.icon_url };
  return out;
}

export function groupReactions(rows: ReactionRow[]) {
  const grouped = new Map<string, { name: string; count: number; users: string[] }>();
  for (const row of rows) {
    const existing = grouped.get(row.name);
    if (existing) {
      existing.count += 1;
      existing.users.push(row.user_id);
    } else {
      grouped.set(row.name, {
        name: row.name,
        count: 1,
        users: [row.user_id],
      } satisfies DeepPartial<SlackReaction>);
    }
  }
  return [...grouped.values()];
}

export function serializeFile(row: FileRow) {
  return {
    id: row.id,
    created: tsToUnix(row.created_at),
    timestamp: tsToUnix(row.created_at),
    name: row.name,
    title: row.title,
    mimetype: row.mimetype,
    filetype: row.filetype,
    pretty_type: prettyFiletype(row.filetype),
    user: row.user_id,
    user_team: row.team_id,
    editable: row.filetype === "text" || row.filetype === "markdown",
    size: row.size,
    mode: "hosted",
    is_external: false,
    external_type: "",
    is_public: false,
    public_url_shared: false,
    display_as_bot: false,
    username: "",
    url_private: row.url_private || `${SLACK_TWIN_FILE_HOST}/files-pri/${row.team_id}-${row.id}/${row.name}`,
    url_private_download: `${SLACK_TWIN_FILE_HOST}/files-pri/${row.team_id}-${row.id}/download/${row.name}`,
    permalink: `${SLACK_TWIN_HOST}/files/${row.user_id}/${row.id}/${row.name}`,
    permalink_public: `${SLACK_TWIN_FILE_HOST}/${row.team_id}-${row.id}-public/${row.name}`,
    // safeJsonArray returns unknown[]; upstream File.channels is string[]. Cast
    // to the upstream field type (mirrors twin-github `as Upstream["field"]`).
    channels: safeJsonArray(row.channels_json) as SlackFileInfo["channels"],
    groups: [],
    ims: [],
    comments_count: 0,
  } satisfies DeepPartial<SlackFileInfo>;
}

export function serializeBookmark(row: BookmarkRow) {
  return {
    id: row.id,
    channel_id: row.channel_id,
    title: row.title,
    link: row.link,
    emoji: row.emoji ?? "",
    icon_url: "",
    type: row.type,
    entity_id: "",
    date_created: tsToUnix(row.created_at),
    date_updated: tsToUnix(row.created_at),
    rank: "",
    last_updated_by_user_id: row.created_by,
    last_updated_by_team_id: "",
    shortcut_id: "",
    app_id: "",
    app_action_id: "",
  } satisfies DeepPartial<SlackBookmark>;
}

export function serializeScheduledMessage(row: ScheduledMessageRow) {
  // `thread_ts` has no key in the upstream ScheduledMessage type, so it is held
  // out of the satisfies anchor and spread back via a narrow cast (mirrors the
  // twin-github repoJson parentRef hold-out).
  const base = {
    id: row.id,
    channel_id: row.channel_id,
    post_at: row.post_at,
    date_created: row.date_created,
    text: row.text,
  } satisfies DeepPartial<SlackScheduledMessage>;
  return {
    ...base,
    ...(row.thread_ts ? { thread_ts: row.thread_ts } : {}),
  };
}

export function serializePin(pin: PinRow, message: Record<string, unknown>) {
  return {
    type: "message",
    created: tsToUnix(pin.pinned_at),
    created_by: pin.pinned_by,
    channel: pin.channel_id,
    message,
  };
}

export function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function safeJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

export function tsToUnix(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.floor(ms / 1000);
}

function prettyFiletype(filetype: string): string {
  const mapping: Record<string, string> = {
    text: "Plain Text",
    markdown: "Markdown",
    pdf: "PDF",
    gif: "GIF",
    png: "PNG",
    jpg: "JPEG",
    jpeg: "JPEG",
    binary: "Binary",
  };
  return mapping[filetype] ?? filetype.toUpperCase();
}
