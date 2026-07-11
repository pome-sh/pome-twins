# Stripe Twin Fidelity

`@pome-sh/twin-stripe` is a high-fidelity test double of Stripe's
**x402 machine payments** surface — not a universal Stripe clone. This
page documents exactly which surfaces are faithful to real Stripe today,
at what tier, and how fidelity is verified.

Last verified: 2026-07-11.
Stripe API version pinned: `2026-03-04.preview`.

## What "fidelity" means here

Each REST route and MCP tool is classified into one of three tiers:

- **`semantic`** — the stateful behavior is implemented locally and
  covered by tests. PaymentIntent state-machine transitions, balance
  arithmetic, idempotency-key dedupe, and the rest behave the way agents
  expect when they call real Stripe.
- **`shape`** — the response shape is checked against captured real
  Stripe fixtures, but the underlying behavior is not fully semantic.
  v1 has no shape-tier routes.
- **`unsupported`** — not implemented. The clone returns a loud 501
  envelope (see below) so an agent never silently succeeds against a
  missing route.

Fidelity ("how deep a surface *is*") is one of two orthogonal dimensions;
the other is **heat** ("how deep it *should* be", `hot`/`warm`/`cold`,
ruled per milestone). The engine-level rubric — tier criteria, target
mapping, gap and tier-mismatch semantics — lives at
[`packages/sdk/ENDPOINT-TIERS.md`](../sdk/ENDPOINT-TIERS.md). The `Tier`
column below means fidelity.

The bar Pome aims for: **agents written against real Stripe x402 run
unchanged against this twin**, and trip a loud failure for anything
outside the documented surface.

For the build / runtime / cloud consumer invariants the hosted snapshot
build depends on (port `:3333`, `/healthz`, `STRIPE_CLONE_HOST`,
`npm install`-able package, `node dist/src/server.js`), see
[Runtime contract](./README.md#runtime-contract-for-snapshot-consumers)
in the package README. Changing any of those is a breaking change for
`pome-cloud` and requires a matching cloud consumer PR.

## REST routes (v1 = 23 semantic + everything else loud 501)

| Route | Tier | Tests | Notes |
| --- | --- | --- | --- |
| `POST /s/:sid/v1/payment_intents` | semantic | `pi.test.ts`, `pi-card.test.ts`, `tools.test.ts` | Two rails (F-731): crypto deposit mode (deterministic Base USDC deposit address, starts at `requires_action`) and card (starts at `requires_payment_method`, or `requires_confirmation` with a `payment_method`; `confirm: true` runs the one-shot attempt). |
| `GET /s/:sid/v1/payment_intents/:id` | semantic | `pi.test.ts`, `pi-card.test.ts` | Card PIs surface `last_payment_error` after a declined attempt. |
| `GET /s/:sid/v1/payment_intents` | semantic | `pi.test.ts` | Cursor pagination on `(created, id)` via `starting_after` / `ending_before` (matches Stripe's cursor model). |
| `POST /s/:sid/v1/payment_intents/:id/confirm` | semantic | `pi.test.ts`, `pi-card.test.ts` | Card PIs (F-731): synchronous attempt — success mints charge + balance txn + events; magic test PMs decline with a 402 `card_error` embedding the post-attempt PI. Crypto PIs: idempotent no-op. CAS picks exactly one winner among parallel confirms. |
| `POST /s/:sid/v1/payment_intents/:id` | semantic | `pi-card.test.ts` | Update (F-731, ruled in scope by F-729 point 1) — the retry-with-new-PM step. Metadata merges per-key; attaching a PM moves `requires_payment_method → requires_confirmation`. Refused once terminal. |
| `POST /s/:sid/v1/payment_intents/:id/cancel` | semantic | `pi.test.ts`, `pi-card.test.ts` | CAS-on-status; refused once `succeeded`. |
| `POST /s/:sid/v1/test_helpers/payment_intents/:id/simulate_crypto_deposit` | semantic | `pi.test.ts`, `pi-concurrency.test.ts`, `events.test.ts` | The x402 settlement entry point. CAS `requires_action → processing → succeeded`; mints charge + balance txn + 5 events synchronously. |
| `GET /s/:sid/v1/charges/:id` | semantic | `charges.test.ts` | Latest charge of a settled PI. |
| `GET /s/:sid/v1/charges` | semantic | `charges.test.ts` | Filter by `payment_intent`, `customer`. |
| `GET /s/:sid/v1/balance` | semantic | `balance.test.ts` | Available + pending; updated as PIs settle. |
| `GET /s/:sid/v1/balance_transactions` | semantic | `balance.test.ts` | Ledger entries. |
| `GET /s/:sid/v1/events/:id` | semantic | `events.test.ts` | |
| `GET /s/:sid/v1/events` | semantic | `events.test.ts` | Filter by `type`, `created`. **No webhook delivery in v1** — agents poll this. |
| `POST /s/:sid/v1/customers` | semantic | `customers.test.ts` | F-732 (heat: hot, ruled F-729). Every field optional, like real Stripe. Emits `customer.created`. |
| `GET /s/:sid/v1/customers/:id` | semantic | `customers.test.ts` | Deleted customers serve the `{deleted: true}` stub, like real Stripe. |
| `GET /s/:sid/v1/customers` | semantic | `customers.test.ts` | Cursor pagination on `(created, id)`; `email` filter; deleted rows excluded. |
| `POST /s/:sid/v1/customers/:id` | semantic | `customers.test.ts` | Update. Metadata merges per-key; an empty value unsets the key (Stripe's metadata contract). |
| `DELETE /s/:sid/v1/customers/:id` | semantic | `customers.test.ts` | Soft delete; detaches the customer's payment methods in the same transaction. Idempotent. |
| `GET /s/:sid/v1/customers/:id/payment_methods` | semantic | `payment-methods.test.ts` | The hot card-on-file read. `type` filter. 404 for deleted customers. |
| `POST /s/:sid/v1/payment_methods` | semantic | `payment-methods.test.ts` | Card only (F-731 adds card PIs). Test card numbers → brand/last4; Luhn + expiry `card_error`s; PAN never stored. |
| `GET /s/:sid/v1/payment_methods/:id` | semantic | `payment-methods.test.ts` | Top-level `GET /v1/payment_methods` (list) stays loud 501 per the F-729 ruling. |
| `POST /s/:sid/v1/payment_methods/:id/attach` | semantic | `payment-methods.test.ts` | One customer per PM; a previously-detached PM can never be reattached. Emits `payment_method.attached`. |
| `POST /s/:sid/v1/payment_methods/:id/detach` | semantic | `payment-methods.test.ts` | Emits `payment_method.detached`. |

Anything else under `/v1/*` (`/v1/setup_intents`, `/v1/checkout/*`,
`/v1/products`, `/v1/prices`, `/v1/webhook_endpoints`,
`/v1/shared_payment/*`, `/v1/profiles`, the top-level
`GET /v1/payment_methods` list, etc.) returns:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "endpoint_not_supported",
    "message": "This endpoint is not supported by this Stripe twin clone.",
    "fidelity": "unsupported",
    "supported_surfaces": [
      "Stripe-shaped REST under /v1/* (see FIDELITY.md)",
      "GET /s/:sid/mcp/tools",
      "POST /s/:sid/mcp/call",
      "POST /s/:sid/mcp/tools/:name"
    ]
  }
}
```

HTTP status: 501.

## MCP tools (26 live; 23 documented — names match `stripe-node` method names)

| Tool | Backing route | Tier |
| --- | --- | --- |
| `create_payment_intent` | POST /v1/payment_intents | semantic |
| `retrieve_payment_intent` | GET /v1/payment_intents/:id | semantic |
| `list_payment_intents` | GET /v1/payment_intents | semantic |
| `confirm_payment_intent` | POST /v1/payment_intents/:id/confirm | semantic |
| `update_payment_intent` | POST /v1/payment_intents/:id | semantic |
| `cancel_payment_intent` | POST /v1/payment_intents/:id/cancel | semantic |
| `simulate_crypto_deposit` | POST /v1/test_helpers/.../simulate_crypto_deposit | semantic |
| `retrieve_charge` | GET /v1/charges/:id | semantic |
| `list_charges` | GET /v1/charges | semantic |
| `retrieve_balance` | GET /v1/balance | semantic |
| `list_balance_transactions` | GET /v1/balance_transactions | semantic |
| `retrieve_event` | GET /v1/events/:id | semantic |
| `list_events` | GET /v1/events | semantic |
| `create_customer` | POST /v1/customers | semantic |
| `retrieve_customer` | GET /v1/customers/:id | semantic |
| `update_customer` | POST /v1/customers/:id | semantic |
| `delete_customer` | DELETE /v1/customers/:id | semantic |
| `list_customers` | GET /v1/customers | semantic |
| `list_customer_payment_methods` | GET /v1/customers/:id/payment_methods | semantic |
| `create_payment_method` | POST /v1/payment_methods | semantic |
| `retrieve_payment_method` | GET /v1/payment_methods/:id | semantic |
| `attach_payment_method` | POST /v1/payment_methods/:id/attach | semantic |
| `detach_payment_method` | POST /v1/payment_methods/:id/detach | semantic |

Every MCP tool is callable via both `POST /s/:sid/mcp/call` (with
`{tool, arguments}` body) and `POST /s/:sid/mcp/tools/:name` (with the
arguments as the body). Coverage in `tools.test.ts`.

The tables above are 1:1-linted against the structured inventory
[`fidelity.inventory.json`](fidelity.inventory.json) (which also carries the
hot/warm/cold heat tier per F-729) by `test/fidelity-contract.test.ts`, and
`npm run fidelity:parity` (shared runner in `@pome-sh/sdk/parity`, F-730)
exercises every inventoried tool end-to-end. Known gaps between code and
these tables — today, the implemented refunds chain — are declared in the
inventory's `doc_drift` with their owning ticket (F-733) and fail the lint
the moment the docs catch up.

## x402 middleware (`src/x402.ts`)

`paymentMiddleware(routeMap, twinOptions)` is a Hono helper that:

- Returns 402 with the canonical `accepts` body when the request lacks
  an `X-PAYMENT` header.
- Decodes the second-leg `X-PAYMENT` (base64 JSON), validates `to` ∈
  cached payTo book, validates `value` matches priced amount, calls
  `simulate_crypto_deposit` to settle the matching PI, then proxies the
  wrapped handler.
- Caches per-route challenges (5 min TTL) so replays don't mint
  duplicate PIs.
- Idempotent: same `X-PAYMENT` header twice returns the same response,
  doesn't double-create state on the twin.

**Known deviation**: v0 does NOT cryptographically verify EIP-3009
signatures. Loud comment block at the top of `src/x402.ts`. We accept
any well-formed `X-PAYMENT` payload that matches our payTo book +
amount.

Tests: `x402.test.ts` (6 cases), `x402-replay.test.ts` (2 cases),
plus the `examples/buyer-agent/` end-to-end demo against a running twin.

## Concurrency contract

- **PI confirm/settle race** (`pi-concurrency.test.ts`): 8 parallel
  `simulate_crypto_deposit` calls on one PI deterministically produce
  exactly one 200 (winner of the `requires_action → processing` CAS)
  and seven 400s with `payment_intent_unexpected_state`. Single
  `charges` row, single `balance_transactions` row, balance reflects
  the PI amount once. The card rail carries the same guarantee
  (`pi-card.test.ts`): 8 parallel confirms → one winner of the
  `requires_confirmation → processing` CAS, single charge.
- **Idempotency-Key** (`idempotency.test.ts`): same key + same body →
  cached response. Same key + different body → 400
  `idempotency_key_in_use`. Caches 2xx/3xx; skips 4xx and 5xx so a
  client with a typo in its first request can retry under the same key
  against a fresh handler invocation (matches real Stripe, which
  re-executes on 4xx for client errors).

## Pome introspection (`/_pome/*`)

These are pome-internal observation routes, not part of Stripe's
surface:

- `GET /healthz` → `{ ok, twin, implementation, fidelity, tools, tthw_seconds }`.
  Snapshot probe. tthw_seconds tracks time since process start (DX
  measurement per plan §21).
- `GET /s/:sid/_pome/health` → per-session liveness.
- `GET /s/:sid/_pome/state` → full domain state export (PIs, charges,
  balance txns, events). For test assertions.
- `GET /s/:sid/_pome/events` → recorder events (HTTP request/response
  log). For test assertions.

Admin (localhost-only):

- `POST /admin/reset` — reset to default seed.
- `POST /admin/seed` — load custom seed JSON.

## Auth shapes accepted

- `Authorization: Bearer sk_test_pome_<sid>` — Stripe-SDK-compatible.
  Default seed mints `sk_test_pome_default` mapped to sid=`default`.
- `Authorization: Bearer <jwt>` where the JWT carries a `sid` claim
  matching the URL — pome's twin-github-style auth.
- `Authorization: <jwt>` (no `Bearer` prefix) — backwards-compat with
  twin-github MCP clients.

When the URL is path-prefixed (`/s/:sid/...`), the resolved sid must
match the `:sid` param. 403 otherwise. When the URL has no `:sid`
prefix (the SDK-compat root mount, see below), the bearer alone
resolves the session.

## SDK-compatibility mount

`/v1/*` routes also work at the root path with the sid resolved from
the bearer. This matches Stripe's URL shape so `stripe-node`,
`stripe-python`, and friends can use `host`/`port` overrides without
monkey-patching the path. Concretely:

```
POST /v1/payment_intents                → uses bearer's sid
POST /s/:sid/v1/payment_intents         → uses path sid (must match bearer)
```

Both shapes hit the same handlers and produce identical responses. The
account-scoping invariant (F1) holds for both: a key for sid=A hitting
the root mount cannot see sid=B's data. `/_pome/*` and `/admin/*` are
not exposed at the root mount — those remain at `/s/:sid/_pome/*` and
`/admin/*` respectively. Tested in `sdk-compat.test.ts`.

## Stripe-Version header

- `Stripe-Version: 2026-03-04.preview` → served as-is.
- Header omitted → served as `2026-03-04.preview` with a default warning.
- Older GA version → 400 `api_version_unsupported` (no shape coercion;
  fail loudly so SDKs that pin GA versions can't accidentally consume
  preview shapes).

## Known divergences from real Stripe (v1)

1. **PI currency restricted to `usd`** on both rails. Non-USD returns
   `currency_not_supported`. (Real Stripe accepts many currencies but
   x402's USD-priced/USDC-paid model is the v1 wedge; card PIs keep the
   same restriction.)
2. **`payment_method_types` restricted to exactly `["crypto"]` or `["card"]`**
   (F-731 added the card rail). Multi-type lists and other types return a
   loud 400. Card attempts settle synchronously with no 3DS /
   `requires_action` step; declines are driven by Stripe's magic test PMs
   (`4000000000000002` generic_decline, `4000000000009995`
   insufficient_funds, `4000000000000069` expired_card, `4000000000000127`
   incorrect_cvc — the decline is keyed off the stored card fingerprint,
   the PAN is never persisted). A declined confirm answers 402 with a
   `card_error` envelope that embeds `decline_code` and the post-attempt
   `payment_intent`, mints a `failed` charge, and records
   `last_payment_error` — the ruled retry step is
   `POST /v1/payment_intents/:id` with a new `payment_method`, then
   confirm again.
3. **Single deposit network and token**. One network (`base`), one token
   (`usdc`). Tempo and Solana from Stripe's published matrix are deferred.
4. **`available_on` equals `created`** for balance transactions (no
   float window).
5. **No webhook delivery loop**. `event_deliveries` table not in v1.
   Agents poll `GET /v1/events`.
6. **EIP-3009 signature verification not enforced** (x402 deviation).
7. **`simulate_crypto_deposit` settles synchronously**; no chain-delay
   simulation.
8. **`confirm_payment_intent` is a no-op for crypto PIs only** (the
   deposit-mode state machine doesn't need a separate confirm step).
   Card confirms are real synchronous attempts (F-731) — and unlike the
   crypto no-op, re-confirming a settled card PI is refused with
   `payment_intent_unexpected_state`.
9. **`/v1/refunds` omits the legacy `count` field**. Real Stripe's
   refunds list envelope still carries a top-level `count`; the twin (like
   its other list surfaces, which match real Stripe exactly) omits this
   deprecated field. The 3 other list surfaces — `payment_intents`,
   `charges`, `balance_transactions` — are verified green against real
   Stripe test mode.
10. **`/v1/events` is not L1-auto-verified**. The empty fidelity world has
    no event history while a real test account accrues events from every
    action, and the live event body embeds account-identifying fields, so
    this surface is left `unverified` (the event object shape is exercised
    at L2 via `simulate_crypto_deposit` instead).
11. **`/v1/balance` is not L1-auto-verified**. Real Stripe returns an
    account-currency zero entry plus `source_types` /
    `refund_and_dispute_prefunding`; the twin's empty `usd` world can't
    reproduce an account-specific balance, so it is left `unverified`
    (balance arithmetic is exercised semantically at L2).
12. **PaymentIntent `payment_method_options.crypto` carries x402 `mode`/`deposit_options`**.
    The twin emits the x402 deposit-mode rail (`mode: "deposit"`,
    `deposit_options.networks: ["base"]`) on every PaymentIntent. The official
    `stripe@22.2.0` `PaymentMethodOptions.Crypto` type has only `setup_future_usage`;
    `mode` / `deposit_options` are x402 extension fields the twin adds. They are
    lifted past the compile-time shape anchor (FDRS-478) via a named-variable spread
    so the rest of the PaymentIntent stays strictly shape-checked.
13. **PaymentIntent `next_action` carries the x402 crypto deposit instruction blob**.
    A `requires_action` PaymentIntent surfaces `next_action` as the deterministic
    Base/USDC deposit instruction (address + amount) the buyer-agent funds. The
    official `PaymentIntent.next_action` union has no crypto-deposit member, so this
    payload is an opaque blob the compile anchor cannot field-check — registered here
    so the x402 extension shape is on the public record.
14. **Event `type`/`data` are lifted past the `EventBase` envelope anchor**. The
    event serializer is anchored against the shared `Stripe.EventBase` envelope
    (id / object / api_version / created / livemode / pending_webhooks / request),
    not the giant `Stripe.Event` discriminated union. `type` (twin emits a free
    `string`; upstream is the `Event.Type` literal union) and `data` (twin stores an
    opaque parsed JSON blob; upstream `Event.Data.object` is a typed resource union)
    are narrowed for the type anchor only (FDRS-454); runtime values unchanged.
15. **Compile anchor pins `stripe@22.2.0` (dahlia), decoupled from the `2026-03-04.preview` wire version**.
    The compile-time shape anchor (FDRS-478) pins the official `stripe` library at
    `22.2.0` (apiVersion 2026-05-27.dahlia), intentionally DECOUPLED from the wire
    apiVersion the twin serves (`2026-03-04.preview`). The anchor guards SHAPE only;
    the wire version is tracked by this page + live capture. Concretely, the dahlia
    types dropped the top-level `invoice` field from PaymentIntent and Charge, which
    the twin still emits faithfully to its preview wire version (lifted past the
    anchor). Bumping `stripe` re-runs the anchor — the FDRS-476 bump → tsc →
    cover-or-register loop — surfacing every upstream shape change by name.

> Pagination is **not** a divergence: `GET /v1/payment_intents` (and the
> other list surfaces) use real cursor pagination keyed on `(created, id)`
> via `starting_after` / `ending_before`, matching Stripe's cursor model.

## Verification commands

```bash
npm run test            # 31 files / 194 tests, all green
npm run smoke           # full x402 flow against built server
npm run fidelity:parity # every inventoried MCP tool end-to-end
npm run typecheck
```
