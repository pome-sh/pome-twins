// SPDX-License-Identifier: Apache-2.0
//
// Spec contract for shape fidelity (FDRS-478 — twin-stripe port of FDRS-475).
//
// This shim anchors the twin's response serializers to Stripe's official
// published TypeScript types (the `stripe` / stripe-node package, devDependency,
// `import type` ONLY — the runtime never imports stripe). The serializers are
// expected to emit a FAITHFUL SUBSET of the upstream schema: omitting fields
// stays legal (DeepPartial makes every field optional), but emitting a
// wrong-named or mistyped field becomes a COMPILE error. This is the
// type-level guard rail — runtime behavior is unchanged.
//
// ANCHOR-LIBRARY-VERSION vs WIRE-VERSION (ST-DIV-012, deliberate decision):
// the anchor pins `stripe@22.2.0` (apiVersion 2026-05-27.dahlia), which is
// DECOUPLED from the wire apiVersion the twin serves (2026-03-04.preview). The
// compile anchor guards SHAPE only; the wire version is tracked by FIDELITY.md +
// live capture. Bumping `stripe` re-runs the anchor (the FDRS-476 bump → tsc →
// decision loop).
// VENDORED-COPY NOTE (FDRS-528): in the package (`packages/twin-stripe`) these
// aliases anchor to Stripe's official `stripe` (stripe-node) types so a
// serializer emitting a wrong-named/mistyped field fails tsc. The shipped CLI
// must not pull `stripe` as a runtime/dev dep (it's a type-only fidelity guard),
// so the vendored copy loosens the anchors to permissive shapes — the same trade
// `cli/src/twin-github` made dropping its `@octokit` anchor and `twin-slack` its
// `@slack/web-api` anchor. The real guard stays in the package; this copy keeps
// `serializers.ts` compiling unchanged via the `satisfies DeepPartial<…>` form.
type StripeUpstreamShape = { [key: string]: unknown };

export type PaymentIntent = StripeUpstreamShape;
export type Charge = StripeUpstreamShape;
export type Refund = StripeUpstreamShape;
export type BalanceTransaction = StripeUpstreamShape;
export type Balance = StripeUpstreamShape;
export type StripeEvent = StripeUpstreamShape;

// Paginated list envelope, kept structural so `serializedList<T>`'s
// `satisfies DeepPartial<ApiList<T>>` still anchors `data` to `T[]`.
export type ApiList<T> = {
  object?: "list";
  data?: T[];
  has_more?: boolean;
  url?: string;
};

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

// FDRS-476 (phase 2 of FDRS-475) — upstream-added-field guard.
// Uncovered = upstream keys the serializer neither emits nor registers as a
// deliberate omission. When that set is empty the assertion is `true`; when it
// is non-empty the type becomes an error-carrying object whose member type
// NAMES the offending field(s), so a post-`stripe`-bump addition fails tsc by name.
export type AssertNoUncovered<Upstream, Emitted, Allow extends PropertyKey> =
  Exclude<keyof Upstream, keyof Emitted | Allow> extends never
    ? true
    : { __UNCOVERED_UPSTREAM_FIELDS__: Exclude<keyof Upstream, keyof Emitted | Allow> };
