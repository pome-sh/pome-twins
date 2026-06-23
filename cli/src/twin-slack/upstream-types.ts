// SPDX-License-Identifier: Apache-2.0
//
// Spec contract for shape fidelity (FDRS-477; mirrors twin-github FDRS-475/476).
//
// VENDORED-COPY NOTE (FDRS-529): in the package (`packages/twin-slack`) these
// aliases anchor to Slack's official response types (`@slack/web-api`), so a
// serializer that emits a wrong-named/mistyped field fails tsc. The shipped CLI
// must not pull `@slack/web-api` as a runtime/dev dep (it's a type-only fidelity
// guard), so the vendored copy loosens the anchors to a permissive shape — the
// same trade `cli/src/twin-github` made when it dropped its `@octokit` anchor.
// The real fidelity guard stays in the package; this copy keeps `serializers.ts`
// compiling unchanged via the `satisfies DeepPartial<…>` form.
type SlackUpstreamShape = { [key: string]: unknown };

export type SlackWorkspace = SlackUpstreamShape;
export type SlackUserProfile = SlackUpstreamShape;
export type SlackUser = SlackUpstreamShape;
export type SlackChannel = SlackUpstreamShape;
export type SlackMessage = SlackUpstreamShape;
export type SlackReaction = SlackUpstreamShape;
export type SlackFileInfo = SlackUpstreamShape;
export type SlackBookmark = SlackUpstreamShape;
export type SlackScheduledMessage = SlackUpstreamShape;

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
