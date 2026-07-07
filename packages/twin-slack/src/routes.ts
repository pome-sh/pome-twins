// SPDX-License-Identifier: Apache-2.0
//
// Slack Web API domain routes (F-683). Pure domain shape: every handler maps
// wire args (query + form/JSON body, Slack's native encodings) onto a
// SlackDomain call and wraps the result in the Slack `{ok:true, ...}`
// envelope. Everything cross-cutting — auth, recording, redaction, error
// envelopes, the 501 catch-all — is the engine's (`@pome-sh/sdk`), wired
// through the twin manifest in ./twin.ts.

import type { Context, Hono } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import type { StateDelta } from "@pome-sh/shared-types";
import type { SlackDomain, Actor } from "./domain.js";
import { TwinError } from "./errors.js";
import { slackOk } from "./serializers.js";
import { asBool, asNumber, asOptionalString, asString, parseFormOrJson } from "./util.js";

type Args = Record<string, unknown>;
type DeltaHook = (delta: StateDelta) => void;

async function readArgs(c: Context): Promise<Args> {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { ...c.req.query() };
  }
  // For POST/PUT — merge query and body so endpoints can accept either.
  const body = await parseFormOrJson(c);
  return { ...c.req.query(), ...body };
}

function actorFrom(c: Context): Actor {
  const session = c.get("session") as { login?: unknown } | undefined;
  return { login: typeof session?.login === "string" ? session.login : undefined };
}

const optNum = (value: unknown, fallback: number) =>
  value === undefined ? undefined : asNumber(value, fallback);

export function registerSlackRoutes(app: Hono, { domain, recorder }: RouteContext<SlackDomain>): void {
  /** Read endpoint mounted on GET + POST (Slack accepts both). */
  const read = (path: string, call: (args: Args, actor: Actor) => Record<string, unknown>) => {
    const handler = recorder.handle({ mutation: false }, async (c) => ({
      status: 200,
      body: slackOk(call(await readArgs(c), actorFrom(c))),
    }));
    app.get(path, handler);
    app.post(path, handler);
  };

  /** Mutation endpoint (POST only) with state-delta capture. */
  const write = (
    path: string,
    call: (args: Args, actor: Actor, delta: DeltaHook) => Record<string, unknown>,
    mutated: (result: Record<string, unknown>) => boolean = () => true
  ) => {
    app.post(
      path,
      recorder.handle({ mutation: true }, async (c) => {
        let delta: StateDelta = null;
        const result = call(await readArgs(c), actorFrom(c), (d) => {
          delta = d;
        });
        return { status: 200, body: slackOk(result), delta, mutation: mutated(result) };
      })
    );
  };

  // ── Auth ──────────────────────────────────────────────────────────────────
  read("/auth.test", (_args, actor) => domain.authTest(actor));

  // ── Conversations ─────────────────────────────────────────────────────────
  read("/conversations.list", (args) =>
    domain.conversationsList({
      types: asOptionalString(args.types),
      exclude_archived: asBool(args.exclude_archived, false),
      limit: optNum(args.limit, 100),
      cursor: asOptionalString(args.cursor),
      team_id: asOptionalString(args.team_id),
    })
  );

  read("/conversations.info", (args, actor) => {
    const channel = asOptionalString(args.channel);
    if (!channel) throw new TwinError("channel_not_found", 400, "channel_not_found");
    return domain.conversationsInfo(
      { channel, include_num_members: asBool(args.include_num_members, false) },
      actor
    );
  });

  write("/conversations.create", (args, actor, delta) =>
    domain.conversationsCreate(
      {
        name: asString(args.name),
        is_private: asBool(args.is_private, false),
        team_id: asOptionalString(args.team_id),
      },
      actor,
      delta
    )
  );

  write("/conversations.archive", (args, actor, delta) =>
    domain.conversationsArchive({ channel: asString(args.channel) }, actor, delta)
  );

  write("/conversations.invite", (args, actor, delta) =>
    domain.conversationsInvite({ channel: asString(args.channel), users: asString(args.users) }, actor, delta)
  );

  write("/conversations.join", (args, actor, delta) =>
    domain.conversationsJoin({ channel: asString(args.channel) }, actor, delta)
  );

  write("/conversations.leave", (args, actor, delta) =>
    domain.conversationsLeave({ channel: asString(args.channel) }, actor, delta)
  );

  write("/conversations.kick", (args, actor, delta) =>
    domain.conversationsKick({ channel: asString(args.channel), user: asString(args.user) }, actor, delta)
  );

  read("/conversations.members", (args, actor) =>
    domain.conversationsMembers(
      {
        channel: asString(args.channel),
        limit: optNum(args.limit, 100),
        cursor: asOptionalString(args.cursor),
      },
      actor
    )
  );

  read("/conversations.history", (args, actor) =>
    domain.conversationsHistory(
      {
        channel: asString(args.channel),
        cursor: asOptionalString(args.cursor),
        inclusive: asBool(args.inclusive, false),
        latest: asOptionalString(args.latest),
        limit: optNum(args.limit, 100),
        oldest: asOptionalString(args.oldest),
      },
      actor
    )
  );

  read("/conversations.replies", (args, actor) =>
    domain.conversationsReplies(
      {
        channel: asString(args.channel),
        ts: asString(args.ts),
        cursor: asOptionalString(args.cursor),
        inclusive: asBool(args.inclusive, false),
        latest: asOptionalString(args.latest),
        limit: optNum(args.limit, 100),
        oldest: asOptionalString(args.oldest),
      },
      actor
    )
  );

  write(
    "/conversations.open",
    (args, actor, delta) =>
      domain.conversationsOpen(
        {
          users: asOptionalString(args.users),
          channel: asOptionalString(args.channel),
          return_im: asBool(args.return_im, false),
        },
        actor,
        delta
      ),
    (result) => !result.already_open
  );

  // ── Chat ──────────────────────────────────────────────────────────────────
  write("/chat.postMessage", (args, actor, delta) =>
    domain.chatPostMessage(
      {
        channel: asString(args.channel),
        text: asOptionalString(args.text),
        blocks: asOptionalString(args.blocks),
        attachments: asOptionalString(args.attachments),
        thread_ts: asOptionalString(args.thread_ts),
        reply_broadcast: asBool(args.reply_broadcast, false),
        icon_emoji: asOptionalString(args.icon_emoji),
        icon_url: asOptionalString(args.icon_url),
        username: asOptionalString(args.username),
        as_user: asBool(args.as_user, false),
      },
      actor,
      delta
    )
  );

  write("/chat.update", (args, actor, delta) =>
    domain.chatUpdate(
      {
        channel: asString(args.channel),
        ts: asString(args.ts),
        text: asOptionalString(args.text),
        blocks: asOptionalString(args.blocks),
        attachments: asOptionalString(args.attachments),
      },
      actor,
      delta
    )
  );

  write("/chat.delete", (args, actor, delta) =>
    domain.chatDelete({ channel: asString(args.channel), ts: asString(args.ts) }, actor, delta)
  );

  write("/chat.scheduleMessage", (args, actor, delta) =>
    domain.chatScheduleMessage(
      {
        channel: asString(args.channel),
        text: asString(args.text),
        post_at: asNumber(args.post_at, 0),
        thread_ts: asOptionalString(args.thread_ts),
        blocks: asOptionalString(args.blocks),
      },
      actor,
      delta
    )
  );

  write("/chat.deleteScheduledMessage", (args, actor, delta) =>
    domain.chatDeleteScheduledMessage(
      { channel: asString(args.channel), scheduled_message_id: asString(args.scheduled_message_id) },
      actor,
      delta
    )
  );

  // ── Reactions ─────────────────────────────────────────────────────────────
  write("/reactions.add", (args, actor, delta) =>
    domain.reactionsAdd(
      { channel: asString(args.channel), timestamp: asString(args.timestamp), name: asString(args.name) },
      actor,
      delta
    )
  );

  write("/reactions.remove", (args, actor, delta) =>
    domain.reactionsRemove(
      { channel: asString(args.channel), timestamp: asString(args.timestamp), name: asString(args.name) },
      actor,
      delta
    )
  );

  read("/reactions.get", (args, actor) =>
    domain.reactionsGet(
      {
        channel: asString(args.channel),
        timestamp: asString(args.timestamp),
        full: asBool(args.full, false),
      },
      actor
    )
  );

  // ── Users ─────────────────────────────────────────────────────────────────
  read("/users.list", (args) =>
    domain.usersList({
      cursor: asOptionalString(args.cursor),
      limit: optNum(args.limit, 100),
      include_locale: asBool(args.include_locale, false),
      team_id: asOptionalString(args.team_id),
    })
  );

  read("/users.info", (args) =>
    domain.usersInfo({ user: asString(args.user), include_locale: asBool(args.include_locale, false) })
  );

  read("/users.lookupByEmail", (args) => domain.usersLookupByEmail({ email: asString(args.email) }));

  read("/users.profile.get", (args, actor) =>
    domain.usersProfileGet(
      { user: asOptionalString(args.user), include_labels: asBool(args.include_labels, false) },
      actor
    )
  );

  write("/users.profile.set", (args, actor, delta) =>
    domain.usersProfileSet(
      {
        user: asOptionalString(args.user),
        profile: asOptionalString(args.profile),
        name: asOptionalString(args.name),
        value: asOptionalString(args.value),
      },
      actor,
      delta
    )
  );

  // ── Pins ──────────────────────────────────────────────────────────────────
  write("/pins.add", (args, actor, delta) =>
    domain.pinsAdd({ channel: asString(args.channel), timestamp: asString(args.timestamp) }, actor, delta)
  );

  write("/pins.remove", (args, actor, delta) =>
    domain.pinsRemove({ channel: asString(args.channel), timestamp: asString(args.timestamp) }, actor, delta)
  );

  read("/pins.list", (args, actor) => domain.pinsList({ channel: asString(args.channel) }, actor));

  // ── Search ────────────────────────────────────────────────────────────────
  read("/search.messages", (args, actor) =>
    domain.searchMessages(
      {
        query: asString(args.query),
        count: optNum(args.count, 20),
        page: optNum(args.page, 1),
        sort: asOptionalString(args.sort),
        sort_dir: asOptionalString(args.sort_dir),
        highlight: asBool(args.highlight, false),
      },
      actor
    )
  );

  // ── Files (metadata-only) ─────────────────────────────────────────────────
  write("/files.upload", (args, actor, delta) =>
    domain.filesUpload(
      {
        channels: asOptionalString(args.channels),
        channel: asOptionalString(args.channel),
        filename: asOptionalString(args.filename),
        title: asOptionalString(args.title),
        filetype: asOptionalString(args.filetype),
        content: asOptionalString(args.content),
        initial_comment: asOptionalString(args.initial_comment),
        thread_ts: asOptionalString(args.thread_ts),
      },
      actor,
      delta
    )
  );

  read("/files.info", (args) => domain.filesInfo({ file: asString(args.file) }));

  read("/files.list", (args) =>
    domain.filesList({
      channel: asOptionalString(args.channel),
      user: asOptionalString(args.user),
      count: optNum(args.count, 100),
      page: optNum(args.page, 1),
      types: asOptionalString(args.types),
    })
  );

  write("/files.delete", (args, actor, delta) =>
    domain.filesDelete({ file: asString(args.file) }, actor, delta)
  );

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  write("/bookmarks.add", (args, actor, delta) =>
    domain.bookmarksAdd(
      {
        channel_id: asString(args.channel_id),
        title: asString(args.title),
        type: asOptionalString(args.type),
        link: asOptionalString(args.link),
        emoji: asOptionalString(args.emoji),
        entity_id: asOptionalString(args.entity_id),
      },
      actor,
      delta
    )
  );

  write("/bookmarks.remove", (args, actor, delta) =>
    domain.bookmarksRemove(
      { channel_id: asString(args.channel_id), bookmark_id: asString(args.bookmark_id) },
      actor,
      delta
    )
  );

  read("/bookmarks.list", (args) => domain.bookmarksList({ channel_id: asString(args.channel_id) }));

  // ── Team ──────────────────────────────────────────────────────────────────
  read("/team.info", (args) => domain.teamInfo({ team: asOptionalString(args.team) }));
}
