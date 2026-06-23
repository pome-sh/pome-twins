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
import type Stripe from "stripe";

// Each name below is reachable under the `Stripe` namespace (verified against
// node_modules/stripe@22.2.0 — `export declare namespace Stripe` re-exports them).
export type PaymentIntent = Stripe.PaymentIntent;
export type Charge = Stripe.Charge;
export type Refund = Stripe.Refund;
export type BalanceTransaction = Stripe.BalanceTransaction;
export type Balance = Stripe.Balance;

// Stripe's paginated list envelope (object: "list", data, has_more, url). Generic
// over the element type so the twin's `serializedList<T>` anchors against it.
export type ApiList<T> = Stripe.ApiList<T>;

// `Stripe.Event` is a GIANT discriminated union of *Event subtypes — anchoring
// against it would force the serializer to satisfy EVERY member. We anchor the
// twin's generic event serializer against the shared envelope interface
// `Stripe.EventBase` (id / object / api_version / created / livemode /
// pending_webhooks / request), the fields every event carries identically.
export type StripeEvent = Stripe.EventBase;

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
