# Stripe Twin Fidelity Matrix

Last verified: 2026-05-10

| Surface | Tier | Contract |
| --- | --- | --- |
| `POST /v1/payment_intents` | semantic | Creates crypto-deposit PaymentIntents with Stripe-shaped `next_action`, client secret, metadata, and errors. |
| `GET /v1/payment_intents/:id` | semantic | Retrieves account-scoped PaymentIntents and returns Stripe-shaped missing-resource errors. |
| `GET /v1/payment_intents` | semantic | Supports `limit`, `starting_after`, `ending_before`, `created`, and `has_more` list semantics. |
| `POST /v1/payment_intents/:id/confirm` | semantic | Crypto-deposit confirm is idempotent and preserves state. |
| `POST /v1/payment_intents/:id/cancel` | semantic | Transitions cancellable PaymentIntents and emits `payment_intent.canceled`. |
| `POST /v1/test_helpers/payment_intents/:id/simulate_crypto_deposit` | semantic | Drives processing/succeeded state, charge creation, balance transaction creation, and events. |
| `GET /v1/charges` and `GET /v1/charges/:id` | semantic | Reads charges emitted by successful PaymentIntents. |
| `GET /v1/balance` and `GET /v1/balance_transactions` | semantic | Reads clone-backed balance state from successful payments. |
| `GET /v1/events` and `GET /v1/events/:id` | semantic | Reads Stripe-shaped event envelopes emitted by PaymentIntent flows. |
| `GET /x402/protected-resource` | semantic | Hosted x402 challenge route emits `402`, verifies `X-PAYMENT`, settles a clone PaymentIntent, and unlocks the resource. |
| Unsupported `/v1/*` paths | unsupported | Returns Stripe-shaped `501 endpoint_not_supported` with `fidelity: "unsupported"`. |
