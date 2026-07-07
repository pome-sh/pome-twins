// SPDX-License-Identifier: Apache-2.0
//
// Canonical loud-501 "unsupported endpoint" envelope for the Slack twin.
//
// Twin-only metadata (`fidelity`, `supported_surfaces`) lives under the `_twin`
// namespace, matching twin-github / twin-stripe. Kept in this dependency-light
// module — no sqlite, no http, no hono — so the cross-twin namespace lint
// (tools/fidelity/lint-twin-namespace.ts) can import the real wire shape without
// booting the app. The twin manifest's `unsupported` hook (`twin.ts`) hands this
// to the engine's 501 catch-all, so the lint can never drift from what ships.

export const SUPPORTED_SURFACES = [
  "auth.test",
  "conversations.list",
  "conversations.info",
  "conversations.create",
  "conversations.archive",
  "conversations.invite",
  "conversations.join",
  "conversations.leave",
  "conversations.kick",
  "conversations.members",
  "conversations.history",
  "conversations.replies",
  "conversations.open",
  "chat.postMessage",
  "chat.update",
  "chat.delete",
  "chat.scheduleMessage",
  "chat.deleteScheduledMessage",
  "reactions.add",
  "reactions.remove",
  "reactions.get",
  "users.list",
  "users.info",
  "users.lookupByEmail",
  "users.profile.get",
  "users.profile.set",
  "pins.add",
  "pins.remove",
  "pins.list",
  "search.messages",
  "files.upload",
  "files.info",
  "files.list",
  "files.delete",
  "bookmarks.add",
  "bookmarks.remove",
  "bookmarks.list",
  "team.info",
];

export const unsupportedEnvelope = {
  status: 501,
  body: {
    ok: false as const,
    error: "unsupported_endpoint",
    _twin: {
      fidelity: "unsupported" as const,
      supported_surfaces: SUPPORTED_SURFACES,
    },
  },
} as const;
