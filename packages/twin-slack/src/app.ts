// SPDX-License-Identifier: Apache-2.0
import type { Context } from "hono";
import { Hono } from "hono";
import { ZodError } from "zod";
import type { StateDelta } from "@pome-sh/shared-types";
import type { Session } from "./auth.js";
import { bearerAuth, requireAdminAuth } from "./auth.js";
import { twinBuildInfo } from "./build-info.js";
import { openSlackTwinDatabase } from "./db.js";
import { SlackDomain } from "./domain.js";
import { TwinError, twinErrorFromSqliteConstraint } from "./errors.js";
import { handleMcpRequest, mcpMethodNotAllowed } from "./mcp.js";
import { defaultSeedState } from "./seed.js";
import { listTools, executeTool, isMutatingTool, toolDefinitions } from "./tools.js";
import { slackError, slackOk } from "./serializers.js";
import { unsupportedEnvelope } from "./unsupported-envelope.js";
import type { Recorder, SlackTwinDatabase } from "./types.js";
import { asBool, asNumber, asString, asOptionalString, nowIso, parseFormOrJson, requestId } from "./util.js";
import { redactSecrets } from "./redaction.js";

export type CreateSlackTwinAppOptions = {
  db?: SlackTwinDatabase;
  domain?: SlackDomain;
  recorder?: Recorder;
  runId?: string;
};

type AppEnv = {
  Variables: {
    session: Session;
  };
};

export function createSlackTwinApp(opts: CreateSlackTwinAppOptions = {}) {
  const db = opts.db ?? openSlackTwinDatabase(":memory:");
  const domain = opts.domain ?? new SlackDomain(db);
  const recorder = opts.recorder;
  const runId = opts.runId ?? "spawn";

  const app = new Hono<AppEnv>();

  // Root health (no auth).
  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      twin: "slack",
      implementation: "slack_clone",
      tools: toolDefinitions.length,
      runtime: twinBuildInfo(),
    });
  });

  // Admin (localhost-only).
  const admin = new Hono<AppEnv>();
  admin.use("*", requireAdminAuth());
  admin.post("/reset", async (c) => {
    return handleAdmin(c, recorder, runId, "admin/reset", async () => {
      let delta: StateDelta = null;
      domain.resetToDefault(defaultSeedState, (d) => {
        delta = d;
      });
      return { ok: true, delta };
    });
  });
  admin.post("/seed", async (c) => {
    return handleAdmin(c, recorder, runId, "admin/seed", async () => {
      const body = await parseFormOrJson(c);
      let delta: StateDelta = null;
      domain.applySeed(body.seed ?? body, (d) => {
        delta = d;
      });
      return { ok: true, delta };
    });
  });
  app.route("/admin", admin);

  // Session-scoped routes — all require bearer JWT.
  const session = new Hono<AppEnv>();
  session.use("*", bearerAuth());

  session.get("/healthz", (c) => c.json({ ok: true, sid: c.req.param("sid") }));

  session.get("/_pome/health", (c) => c.json({ ok: true, twin: "slack" }));
  session.get("/_pome/state", (c) => c.json(redactSecrets(domain.exportState())));
  session.get("/_pome/events", (c) => c.json(recorder ? recorder.events() : []));

  // MCP — JSON-RPC 2.0 streamable HTTP.
  session.post("/mcp", (c) => handleMcpRequest(c, { domain, recorder, runId }));
  session.get("/mcp", (c) => mcpMethodNotAllowed(c));
  session.delete("/mcp", (c) => mcpMethodNotAllowed(c));

  // Legacy tool listing + dispatch.
  session.get("/mcp/tools", (c) => c.json({ tools: listTools() }));
  session.post("/mcp/call", async (c) => {
    const body = await parseFormOrJson(c);
    const name = asOptionalString(body.tool ?? body.name);
    const args = (body.arguments ?? body.params ?? {}) as Record<string, unknown>;
    if (!name) return jsonSlackError(c, "invalid_arguments", 400);
    if (!toolDefinitions.some((t) => t.name === name)) return jsonSlackError(c, "unknown_tool", 404);
    return handle(c, recorder, runId, name, async () => {
      let delta: StateDelta = null;
      const result = executeTool(domain, name, args, (d) => {
        delta = d;
      }, actorFrom(c));
      return { body: ensureOk(result), delta, mutation: isMutatingTool(name) };
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Auth
  // ─────────────────────────────────────────────────────────────────────────

  const handleAuthTest = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "auth.test", async () => {
      const result = domain.authTest(actorFrom(c));
      return { body: slackOk(result) };
    });
  session.get("/auth.test", handleAuthTest);
  session.post("/auth.test", handleAuthTest);

  // ─────────────────────────────────────────────────────────────────────────
  // Conversations
  // ─────────────────────────────────────────────────────────────────────────

  const handleConversationsList = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "conversations.list", async () => {
      const args = await readArgs(c);
      const result = domain.conversationsList({
        types: asOptionalString(args.types),
        exclude_archived: asBool(args.exclude_archived, false),
        limit: args.limit !== undefined ? asNumber(args.limit, 100) : undefined,
        cursor: asOptionalString(args.cursor),
        team_id: asOptionalString(args.team_id),
      });
      return { body: slackOk(result) };
    });
  session.get("/conversations.list", handleConversationsList);
  session.post("/conversations.list", handleConversationsList);

  const handleConversationsInfo = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "conversations.info", async () => {
      const args = await readArgs(c);
      const channel = asOptionalString(args.channel);
      if (!channel) throw new TwinError("channel_not_found", 400, "channel_not_found");
      const result = domain.conversationsInfo(
        {
          channel,
          include_num_members: asBool(args.include_num_members, false),
        },
        actorFrom(c)
      );
      return { body: slackOk(result) };
    });
  session.get("/conversations.info", handleConversationsInfo);
  session.post("/conversations.info", handleConversationsInfo);

  session.post("/conversations.create", async (c) =>
    handle(c, recorder, runId, "conversations.create", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.conversationsCreate(
        {
          name: asString(args.name),
          is_private: asBool(args.is_private, false),
          team_id: asOptionalString(args.team_id),
        },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/conversations.archive", async (c) =>
    handle(c, recorder, runId, "conversations.archive", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.conversationsArchive(
        { channel: asString(args.channel) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/conversations.invite", async (c) =>
    handle(c, recorder, runId, "conversations.invite", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.conversationsInvite(
        { channel: asString(args.channel), users: asString(args.users) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/conversations.join", async (c) =>
    handle(c, recorder, runId, "conversations.join", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.conversationsJoin(
        { channel: asString(args.channel) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/conversations.leave", async (c) =>
    handle(c, recorder, runId, "conversations.leave", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.conversationsLeave(
        { channel: asString(args.channel) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/conversations.kick", async (c) =>
    handle(c, recorder, runId, "conversations.kick", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.conversationsKick(
        { channel: asString(args.channel), user: asString(args.user) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  const handleConversationsMembers = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "conversations.members", async () => {
      const args = await readArgs(c);
      const result = domain.conversationsMembers(
        {
          channel: asString(args.channel),
          limit: args.limit !== undefined ? asNumber(args.limit, 100) : undefined,
          cursor: asOptionalString(args.cursor),
        },
        actorFrom(c)
      );
      return { body: slackOk(result) };
    });
  session.get("/conversations.members", handleConversationsMembers);
  session.post("/conversations.members", handleConversationsMembers);

  const handleConversationsHistory = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "conversations.history", async () => {
      const args = await readArgs(c);
      const result = domain.conversationsHistory(
        {
          channel: asString(args.channel),
          cursor: asOptionalString(args.cursor),
          inclusive: asBool(args.inclusive, false),
          latest: asOptionalString(args.latest),
          limit: args.limit !== undefined ? asNumber(args.limit, 100) : undefined,
          oldest: asOptionalString(args.oldest),
        },
        actorFrom(c)
      );
      return { body: slackOk(result) };
    });
  session.get("/conversations.history", handleConversationsHistory);
  session.post("/conversations.history", handleConversationsHistory);

  const handleConversationsReplies = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "conversations.replies", async () => {
      const args = await readArgs(c);
      const result = domain.conversationsReplies(
        {
          channel: asString(args.channel),
          ts: asString(args.ts),
          cursor: asOptionalString(args.cursor),
          inclusive: asBool(args.inclusive, false),
          latest: asOptionalString(args.latest),
          limit: args.limit !== undefined ? asNumber(args.limit, 100) : undefined,
          oldest: asOptionalString(args.oldest),
        },
        actorFrom(c)
      );
      return { body: slackOk(result) };
    });
  session.get("/conversations.replies", handleConversationsReplies);
  session.post("/conversations.replies", handleConversationsReplies);

  session.post("/conversations.open", async (c) =>
    handle(c, recorder, runId, "conversations.open", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.conversationsOpen(
        {
          users: asOptionalString(args.users),
          channel: asOptionalString(args.channel),
          return_im: asBool(args.return_im, false),
        },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: !result.already_open };
    })
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Chat
  // ─────────────────────────────────────────────────────────────────────────

  session.post("/chat.postMessage", async (c) =>
    handle(c, recorder, runId, "chat.postMessage", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.chatPostMessage(
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
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/chat.update", async (c) =>
    handle(c, recorder, runId, "chat.update", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.chatUpdate(
        {
          channel: asString(args.channel),
          ts: asString(args.ts),
          text: asOptionalString(args.text),
          blocks: asOptionalString(args.blocks),
          attachments: asOptionalString(args.attachments),
        },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/chat.delete", async (c) =>
    handle(c, recorder, runId, "chat.delete", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.chatDelete(
        { channel: asString(args.channel), ts: asString(args.ts) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/chat.scheduleMessage", async (c) =>
    handle(c, recorder, runId, "chat.scheduleMessage", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.chatScheduleMessage(
        {
          channel: asString(args.channel),
          text: asString(args.text),
          post_at: asNumber(args.post_at, 0),
          thread_ts: asOptionalString(args.thread_ts),
          blocks: asOptionalString(args.blocks),
        },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/chat.deleteScheduledMessage", async (c) =>
    handle(c, recorder, runId, "chat.deleteScheduledMessage", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.chatDeleteScheduledMessage(
        { channel: asString(args.channel), scheduled_message_id: asString(args.scheduled_message_id) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Reactions
  // ─────────────────────────────────────────────────────────────────────────

  session.post("/reactions.add", async (c) =>
    handle(c, recorder, runId, "reactions.add", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.reactionsAdd(
        {
          channel: asString(args.channel),
          timestamp: asString(args.timestamp),
          name: asString(args.name),
        },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/reactions.remove", async (c) =>
    handle(c, recorder, runId, "reactions.remove", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.reactionsRemove(
        {
          channel: asString(args.channel),
          timestamp: asString(args.timestamp),
          name: asString(args.name),
        },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  const handleReactionsGet = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "reactions.get", async () => {
      const args = await readArgs(c);
      const result = domain.reactionsGet(
        {
          channel: asString(args.channel),
          timestamp: asString(args.timestamp),
          full: asBool(args.full, false),
        },
        actorFrom(c)
      );
      return { body: slackOk(result) };
    });
  session.get("/reactions.get", handleReactionsGet);
  session.post("/reactions.get", handleReactionsGet);

  // ─────────────────────────────────────────────────────────────────────────
  // Users
  // ─────────────────────────────────────────────────────────────────────────

  const handleUsersList = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "users.list", async () => {
      const args = await readArgs(c);
      const result = domain.usersList({
        cursor: asOptionalString(args.cursor),
        limit: args.limit !== undefined ? asNumber(args.limit, 100) : undefined,
        include_locale: asBool(args.include_locale, false),
        team_id: asOptionalString(args.team_id),
      });
      return { body: slackOk(result) };
    });
  session.get("/users.list", handleUsersList);
  session.post("/users.list", handleUsersList);

  const handleUsersInfo = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "users.info", async () => {
      const args = await readArgs(c);
      const result = domain.usersInfo({
        user: asString(args.user),
        include_locale: asBool(args.include_locale, false),
      });
      return { body: slackOk(result) };
    });
  session.get("/users.info", handleUsersInfo);
  session.post("/users.info", handleUsersInfo);

  const handleUsersLookupByEmail = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "users.lookupByEmail", async () => {
      const args = await readArgs(c);
      const result = domain.usersLookupByEmail({ email: asString(args.email) });
      return { body: slackOk(result) };
    });
  session.get("/users.lookupByEmail", handleUsersLookupByEmail);
  session.post("/users.lookupByEmail", handleUsersLookupByEmail);

  const handleUsersProfileGet = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "users.profile.get", async () => {
      const args = await readArgs(c);
      const result = domain.usersProfileGet(
        {
          user: asOptionalString(args.user),
          include_labels: asBool(args.include_labels, false),
        },
        actorFrom(c)
      );
      return { body: slackOk(result) };
    });
  session.get("/users.profile.get", handleUsersProfileGet);
  session.post("/users.profile.get", handleUsersProfileGet);

  session.post("/users.profile.set", async (c) =>
    handle(c, recorder, runId, "users.profile.set", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.usersProfileSet(
        {
          user: asOptionalString(args.user),
          profile: asOptionalString(args.profile),
          name: asOptionalString(args.name),
          value: asOptionalString(args.value),
        },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Pins
  // ─────────────────────────────────────────────────────────────────────────

  session.post("/pins.add", async (c) =>
    handle(c, recorder, runId, "pins.add", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.pinsAdd(
        { channel: asString(args.channel), timestamp: asString(args.timestamp) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/pins.remove", async (c) =>
    handle(c, recorder, runId, "pins.remove", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.pinsRemove(
        { channel: asString(args.channel), timestamp: asString(args.timestamp) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  const handlePinsList = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "pins.list", async () => {
      const args = await readArgs(c);
      const result = domain.pinsList({ channel: asString(args.channel) }, actorFrom(c));
      return { body: slackOk(result) };
    });
  session.get("/pins.list", handlePinsList);
  session.post("/pins.list", handlePinsList);

  // ─────────────────────────────────────────────────────────────────────────
  // Search
  // ─────────────────────────────────────────────────────────────────────────

  const handleSearchMessages = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "search.messages", async () => {
      const args = await readArgs(c);
      const result = domain.searchMessages(
        {
          query: asString(args.query),
          count: args.count !== undefined ? asNumber(args.count, 20) : undefined,
          page: args.page !== undefined ? asNumber(args.page, 1) : undefined,
          sort: asOptionalString(args.sort),
          sort_dir: asOptionalString(args.sort_dir),
          highlight: asBool(args.highlight, false),
        },
        actorFrom(c)
      );
      return { body: slackOk(result) };
    });
  session.get("/search.messages", handleSearchMessages);
  session.post("/search.messages", handleSearchMessages);

  // ─────────────────────────────────────────────────────────────────────────
  // Files (metadata-only)
  // ─────────────────────────────────────────────────────────────────────────

  session.post("/files.upload", async (c) =>
    handle(c, recorder, runId, "files.upload", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.filesUpload(
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
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  const handleFilesInfo = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "files.info", async () => {
      const args = await readArgs(c);
      const result = domain.filesInfo({ file: asString(args.file) });
      return { body: slackOk(result) };
    });
  session.get("/files.info", handleFilesInfo);
  session.post("/files.info", handleFilesInfo);

  const handleFilesList = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "files.list", async () => {
      const args = await readArgs(c);
      const result = domain.filesList({
        channel: asOptionalString(args.channel),
        user: asOptionalString(args.user),
        count: args.count !== undefined ? asNumber(args.count, 100) : undefined,
        page: args.page !== undefined ? asNumber(args.page, 1) : undefined,
        types: asOptionalString(args.types),
      });
      return { body: slackOk(result) };
    });
  session.get("/files.list", handleFilesList);
  session.post("/files.list", handleFilesList);

  session.post("/files.delete", async (c) =>
    handle(c, recorder, runId, "files.delete", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.filesDelete({ file: asString(args.file) }, actorFrom(c), (d) => {
        delta = d;
      });
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Bookmarks
  // ─────────────────────────────────────────────────────────────────────────

  session.post("/bookmarks.add", async (c) =>
    handle(c, recorder, runId, "bookmarks.add", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.bookmarksAdd(
        {
          channel_id: asString(args.channel_id),
          title: asString(args.title),
          type: asOptionalString(args.type),
          link: asOptionalString(args.link),
          emoji: asOptionalString(args.emoji),
          entity_id: asOptionalString(args.entity_id),
        },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  session.post("/bookmarks.remove", async (c) =>
    handle(c, recorder, runId, "bookmarks.remove", async () => {
      const args = await readArgs(c);
      let delta: StateDelta = null;
      const result = domain.bookmarksRemove(
        { channel_id: asString(args.channel_id), bookmark_id: asString(args.bookmark_id) },
        actorFrom(c),
        (d) => {
          delta = d;
        }
      );
      return { body: slackOk(result), delta, mutation: true };
    })
  );

  const handleBookmarksList = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "bookmarks.list", async () => {
      const args = await readArgs(c);
      const result = domain.bookmarksList({ channel_id: asString(args.channel_id) });
      return { body: slackOk(result) };
    });
  session.get("/bookmarks.list", handleBookmarksList);
  session.post("/bookmarks.list", handleBookmarksList);

  // ─────────────────────────────────────────────────────────────────────────
  // Team
  // ─────────────────────────────────────────────────────────────────────────

  const handleTeamInfo = async (c: Context<AppEnv>) =>
    handle(c, recorder, runId, "team.info", async () => {
      const args = await readArgs(c);
      const result = domain.teamInfo({ team: asOptionalString(args.team) });
      return { body: slackOk(result) };
    });
  session.get("/team.info", handleTeamInfo);
  session.post("/team.info", handleTeamInfo);

  // Catch-all 501. Twin-only fields (`fidelity`, `supported_surfaces`) live under
  // the `_twin` namespace, matching twin-github / twin-stripe. Envelope defined
  // once in ./unsupported-envelope.ts so the cross-twin namespace lint checks the
  // shipped shape.
  session.all("*", (c) => {
    return c.json(unsupportedEnvelope.body, unsupportedEnvelope.status);
  });

  app.route("/s/:sid", session);

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function actorFrom(c: Context<AppEnv>) {
  const session = c.get("session");
  return { login: session?.login };
}

async function readArgs(c: Context): Promise<Record<string, unknown>> {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    const query = c.req.query();
    return { ...query };
  }
  // For POST/PUT — merge query and body so endpoints can accept either.
  const body = await parseFormOrJson(c);
  const query = c.req.query();
  return { ...query, ...body };
}

function ensureOk(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if ("ok" in obj) return obj;
    return { ok: true, ...obj };
  }
  return { ok: true, result: value };
}

type RouteOutcome = { body: Record<string, unknown>; delta?: StateDelta; mutation?: boolean };

async function handle(
  c: Context<AppEnv>,
  recorder: Recorder | undefined,
  runId: string,
  method: string,
  fn: () => Promise<RouteOutcome>
): Promise<Response> {
  const started = Date.now();
  let status = 200;
  let responseBody: unknown;
  let stateDelta: StateDelta = null;
  let mutation = false;
  let errorString: string | null = null;
  let outcomeResponse: Response;

  try {
    const outcome = await fn();
    responseBody = outcome.body;
    stateDelta = outcome.delta ?? null;
    mutation = Boolean(outcome.mutation && status < 400);
    outcomeResponse = c.json(outcome.body);
  } catch (err) {
    if (err instanceof TwinError) {
      // Application-level Slack errors return HTTP 200 with {ok:false, error}.
      // This matches real Slack and is required by every official SDK
      // (@slack/web-api, @slack/bolt) — non-200 is treated as a transport
      // failure, not a parseable response. Auth middleware errors keep their
      // native 401 (handled in auth.ts, not here). Admin-gate restricted_action
      // is a TwinError too — also keeps its native status because admin
      // endpoints are twin-internal, not Slack API.
      status = 200;
      responseBody = { ok: false, error: err.code, ...(err.extra ?? {}) };
      errorString = err.code;
      outcomeResponse = c.json(responseBody, 200);
    } else if (err instanceof ZodError) {
      // Slack returns 200 + {ok:false, error:"invalid_arguments", response_metadata.messages}
      // for validation errors. Match that.
      status = 200;
      responseBody = {
        ok: false,
        error: "invalid_arguments",
        response_metadata: {
          messages: err.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
        },
      };
      errorString = "invalid_arguments";
      outcomeResponse = c.json(responseBody, 200);
    } else {
      const mapped = twinErrorFromSqliteConstraint(method, err);
      if (mapped) {
        status = 200;
        responseBody = { ok: false, error: mapped.code, ...(mapped.extra ?? {}) };
        errorString = mapped.code;
        outcomeResponse = c.json(responseBody, 200);
      } else {
        // Genuine server bugs return 5xx so platform retries / alerting kick in.
        status = 500;
        const message = err instanceof Error ? err.message : "internal_error";
        responseBody = { ok: false, error: "internal_error", warning: message };
        errorString = message;
        outcomeResponse = c.json(responseBody, 500);
      }
    }
  }

  recordEvent(c, recorder, runId, method, {
    started,
    status,
    body: responseBody,
    delta: status < 400 && !errorString ? stateDelta : null,
    mutation: status < 400 && !errorString && mutation,
    error: errorString,
  });

  return outcomeResponse;
}

async function handleAdmin(
  c: Context<AppEnv>,
  recorder: Recorder | undefined,
  runId: string,
  method: string,
  fn: () => Promise<{ ok: true; delta: StateDelta }>
): Promise<Response> {
  const started = Date.now();
  let status = 200;
  let responseBody: unknown;
  let stateDelta: StateDelta = null;
  let errorString: string | null = null;
  let outcomeResponse: Response;
  try {
    const result = await fn();
    responseBody = { ok: result.ok };
    stateDelta = result.delta;
    outcomeResponse = c.json({ ok: result.ok });
  } catch (err) {
    status = 500;
    const message = err instanceof Error ? err.message : "internal_error";
    responseBody = { ok: false, error: "internal_error", warning: message };
    errorString = message;
    outcomeResponse = c.json(responseBody, 500);
  }

  recordEvent(c, recorder, runId, method, {
    started,
    status,
    body: responseBody,
    delta: stateDelta,
    mutation: status < 400,
    error: errorString,
  });
  return outcomeResponse;
}

function recordEvent(
  c: Context,
  recorder: Recorder | undefined,
  runId: string,
  method: string,
  fields: { started: number; status: number; body: unknown; delta: StateDelta; mutation: boolean; error: string | null }
) {
  if (!recorder) return;
  const reqId = requestId();
  recorder.record({
    ts: nowIso(),
    run_id: runId,
    twin: "slack",
    request_id: reqId,
    correlation_id: reqId,
    scenario_step_id: c.req.header("x-pome-scenario-step-id") ?? null,
    step_id: null,
    tool_call_id: null,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    request_body: { route: method },
    status: fields.status,
    response_body: fields.body,
    latency_ms: Date.now() - fields.started,
    fidelity: "semantic",
    state_mutation: fields.mutation,
    state_delta: fields.delta,
    error: fields.error,
  });
}

function jsonSlackError(c: Context, code: string, status: number): Response {
  return c.json(slackError(code), status as 400 | 401 | 403 | 404 | 422);
}
