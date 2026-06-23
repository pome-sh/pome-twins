// SPDX-License-Identifier: Apache-2.0
//
// Spec contract for shape fidelity (FDRS-477; mirrors twin-github FDRS-475/476).
//
// This shim anchors the twin's response serializers to Slack's official
// response types (`@slack/web-api`). The serializers are expected to emit a
// FAITHFUL SUBSET of the upstream schema: omitting fields stays legal
// (DeepPartial makes every field optional), but emitting a wrong-named or
// mistyped field becomes a COMPILE error. This is the type-level guard rail —
// runtime behavior is unchanged.
import type {
  BookmarksListResponse,
  ChatScheduledMessagesListResponse,
  ConversationsHistoryResponse,
  ConversationsInfoResponse,
  FilesInfoResponse,
  TeamInfoResponse,
  UsersInfoResponse,
  UsersProfileGetResponse,
} from "@slack/web-api";

// Nested aliases per anchored serializer. Each Slack Response type carries the
// payload under a single optional property (e.g. `team`, `channel`, `user`);
// we wrap in NonNullable so DeepPartial maps over the object shape rather than
// `Object | undefined`. Array-element targets alias to the element type.
export type SlackWorkspace = NonNullable<TeamInfoResponse["team"]>;
export type SlackUserProfile = NonNullable<UsersProfileGetResponse["profile"]>;
export type SlackUser = NonNullable<UsersInfoResponse["user"]>;
export type SlackChannel = NonNullable<ConversationsInfoResponse["channel"]>;
export type SlackMessage = NonNullable<ConversationsHistoryResponse["messages"]>[number];
export type SlackReaction = NonNullable<SlackMessage["reactions"]>[number];
export type SlackFileInfo = NonNullable<FilesInfoResponse["file"]>;
export type SlackBookmark = NonNullable<BookmarksListResponse["bookmarks"]>[number];
export type SlackScheduledMessage = NonNullable<ChatScheduledMessagesListResponse["scheduled_messages"]>[number];

// Recursive deep-partial: every object property becomes optional and is itself
// deep-partial'd; arrays become Array<DeepPartial<element>>; primitives (and
// function types) pass through unchanged. This is what encodes "faithful
// subset": a serializer may OMIT any field, but a field it DOES emit must
// match the upstream name and (deep-partial) type.
export type DeepPartial<T> = T extends (infer U)[]
  ? Array<DeepPartial<U>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// Upstream-added-field guard (mirrors twin-github FDRS-476).
// Uncovered = upstream keys the serializer neither emits nor registers as a
// deliberate omission. When that set is empty the assertion is `true`; when it
// is non-empty the type becomes an error-carrying object whose member type
// NAMES the offending field(s), so an @slack/web-api bump that adds a field
// fails tsc by name.
export type AssertNoUncovered<Upstream, Emitted, Allow extends PropertyKey> =
  Exclude<keyof Upstream, keyof Emitted | Allow> extends never
    ? true
    : { __UNCOVERED_UPSTREAM_FIELDS__: Exclude<keyof Upstream, keyof Emitted | Allow> };
