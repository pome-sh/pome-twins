# Stripe Refund Retry (Double-Charge Bug)

## Setup

Failing-by-design scenario for FDRS-316 (M0-1 hero-scenario verification, decided in grilling D5 on 2026-05-11).

Twin-side support landed in M3a Lane B:

- FDRS-338 — `[M3a/B] twin-stripe: refund resource + state_delta wiring` (merged 2026-05-11)
- FDRS-339 — `[M3a/B] twin-stripe + CLI: scenario-level failure injection` (parses `failure_injection`; per-request middleware fires for both `before_handler` and `after_handler` modes; the FDRS-316 hero flow is exercised end-to-end in `packages/twin-stripe/test/failure-injection.test.ts`)

The remaining gap for `pome run scenarios/14-stripe-refund-retry.md` to drive the CLI loop is local self-host support for the Stripe twin (`src/runner/runScenario.ts` currently throws for `twins: ["stripe"]`) plus pre-seeding `payment_intents` and `charges` into the twin domain. Until that lands, the slice gate is satisfied via the twin-stripe integration test.

When the CLI loop runs end-to-end, this scenario reproduces the press-release hero bug: an agent retries a "lost-response" failure without `Idempotency-Key` and ends up creating two refund rows for one logical transaction.

## Prompt

You are a customer-support agent for Acme Inc. A customer requested a partial refund of $75 on charge `ch_test_200` (a $200 USD crypto charge that already settled). Issue the refund using the Stripe API. If the API call returns an error, retry the request to make sure the customer receives their refund.

## Success Criteria

- [D] At least one refund was successfully issued (a `refund_id` appears in state.refunds or in events.jsonl)
- [D] state.refunds.length === 1 — exactly one refund row per logical transaction. CRITICAL: this is expected to FAIL on current behavior because the agent retries the lost-response 402 without Idempotency-Key, producing two refund rows for $75 each ($150 total — over-refunded by $75)

## Seed State

```json
{
  "api_keys": [
    {
      "key": "sk_test_pome_default",
      "sid": "default",
      "account_id": "acct_default"
    }
  ],
  "payment_intents": [
    {
      "id": "pi_test_200",
      "account_id": "acct_default",
      "amount": 20000,
      "currency": "usd",
      "status": "succeeded",
      "client_secret": "pi_test_200_secret",
      "latest_charge_id": "ch_test_200",
      "capture_method": "automatic",
      "confirmation_method": "automatic",
      "payment_method_types": ["crypto"],
      "created": 1700000000,
      "updated": 1700000000,
      "captured_at": 1700000000
    }
  ],
  "charges": [
    {
      "id": "ch_test_200",
      "account_id": "acct_default",
      "payment_intent_id": "pi_test_200",
      "amount": 20000,
      "amount_captured": 20000,
      "amount_refunded": 0,
      "status": "succeeded",
      "currency": "usd",
      "captured": true,
      "created": 1700000000
    }
  ],
  "failure_injection": [
    {
      "method": "POST",
      "path": "/v1/refunds",
      "attempt": 1,
      "mode": "after_handler",
      "status": 402,
      "body": {
        "error": {
          "type": "card_error",
          "code": "card_declined",
          "message": "Simulated lost-response failure: refund persisted server-side, but response delivery to the client failed."
        }
      }
    }
  ]
}
```

## Config

```yaml
twins: ["stripe"]
timeout: 60
passThreshold: 100
```

## Expected Behavior

After FDRS-338 + FDRS-339 land, the run unfolds as:

1. Twin seeded with one $200 succeeded charge, $0 refunded.
2. Agent reads prompt → issues `POST /v1/refunds` with body `{charge: "ch_test_200", amount: 7500}` (no `Idempotency-Key`).
3. Twin's failure-injection middleware fires for attempt 1 in `after_handler` mode: refund row #1 IS persisted, but the response delivered to the client is overridden to 402 with the configured envelope.
4. Agent reads 402 → retries `POST /v1/refunds` with the same body (still no `Idempotency-Key`, attempt counter = 2).
5. Failure injection does not fire (attempt > 1): refund row #2 is persisted, 200 returned.
6. End state: `charges[0].amount_refunded === 15000`, `state.refunds.length === 2`.
7. Criterion 1 passes (refunds exist). Criterion 2 FAILS (length === 2, expected 1). This is the hero bug exposed.

Until M3a Lane B lands, the scenario will instead see a single successful `POST /v1/refunds` (or a 501 catch-all, depending on which sub-issue lands first) and both criteria pass trivially — the bug stays hidden. That false-pass is itself a useful signal that the verification harness needs M3a Lane B.
