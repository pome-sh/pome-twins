---
"pome-sh": minor
---

**Evaluator: unified per-criterion outcome model, Stripe payment matchers, and a deterministic golden gate (FDRS-591 / FDRS-611 / FDRS-597 / FDRS-646).**

- **Unified outcome model (FDRS-591 + FDRS-611).** Each criterion now carries an
  explicit four-state `outcome`: `passed | failed | skipped | errored`. `skipped`
  = the harness could not evaluate deterministically (no predicate / no judge);
  `errored` = a judge/infra failure (LLM 429/5xx, provider error). Both are
  excluded from the satisfaction denominator (`passed / (passed + failed)`) and
  surfaced as explicit counts. An all-skipped / all-errored run renders as
  **un-evaluated**, never as a misleading 0%. **A5 inflation guard:** a scenario
  can only PASS if every required criterion was actually evaluated — so
  "1 passed + 9 skipped = 100%" can no longer read as a pass. Fields are additive
  and optional; `skipped: boolean` is preserved for existing consumers.

- **Stripe matchers (FDRS-597, M2 headline bug).** The Stripe evaluator only
  recognised refund criteria, so a correct agent scored 0% on scenarios 10–13.
  Added matchers for PaymentIntent create/amount/status, Stripe-shaped error
  surfacing, emitted events (`payment_intent.succeeded`, …), charge +
  balance-transaction creation, and the x402 402→200 challenge flow. Refund
  behavior (scenarios 14/19) is preserved.

- **Golden-scenario CI gate (FDRS-646).** A deterministic, `[D]`-only test
  (`cli/test/golden/`) plus a workflow (`.github/workflows/golden-gate.yml`) that
  needs no live LLM: it asserts a correct-agent fixture scores ≥ threshold and a
  wrong-agent fixture scores below it, with the expected per-criterion breakdown.

Note (A1 caveat, FDRS-618): pome-cloud re-resolves scores with its own hosted
judge and does not yet implement these outcome semantics, so local and hosted
scores can differ for the same trace until FDRS-618 adopts them cloud-side.
