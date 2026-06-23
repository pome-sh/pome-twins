<!--
SPDX-License-Identifier: Apache-2.0
-->

# `@pome-sh/correlator`

Pure-function correlator that turns a recorder's `events.jsonl` plus optional
adapter signals into the `{ lanes, steps }` shape consumed by the dashboard's
lane-timeline and state-inspector.

Two paths live in this package:

| Function | Input | Use when |
|---|---|---|
| `correlateAdapterRich(events, adapterSignals)` | recorder events + JSONL adapter signals | The agent uses `@pome-sh/adapter-claude-sdk` (or any framework that emits the same step / tool_call signal stream). |
| `correlateHeuristic(events, options?)` | recorder events only | No adapter signals available — group by HTTP-call timing + endpoint pattern. |

## Constraints

Both functions are **pure**: no IO, no network, no clock reads, no `Date.now()`,
no random IDs. The same input always produces the same output. Run them in a
worker, in a Lambda, in the browser — the result is identical.

## Adapter signal shape

The adapter writes a JSONL stream (one event per line) to the path in
`POME_ADAPTER_SIGNALS_PATH`. Each line is one of:

```json
{ "ts": "2026-05-11T20:00:00.000Z", "type": "step",      "step_id": "stp_..." }
{ "ts": "2026-05-11T20:00:01.000Z", "type": "tool_call", "tool_call_id": "tlc_...", "tool_name": "..." }
```

Consumers that want dashboard lane enrichment read the file after the agent
subprocess exits and pass the parsed lines as `adapterSignals` to
`correlateAdapterRich`.

## Heuristic path: scope discipline

The heuristic path is **best-effort for v1**. Its acceptance test is **one
bundled scenario**: a raw OpenAI SDK agent against the Stripe twin replaying
the refund-retry-double-charge flow (FDRS-340 trace lives with the CLI
scenario fixtures at [`cli/scenarios/`](../../cli/scenarios/)).

It is **not** promised to produce visually meaningful lanes for every agent
framework or every scenario. Generalising the heuristic — Stripe resource-id
detection, GitHub `/repos/{owner}/{name}/...` family extraction, multi-modal
clustering — lives in v1.5+ as a community contribution path. If you are
running an agent that imports `@pome-sh/adapter-claude-sdk`, prefer
`correlateAdapterRich`.

### Heuristic algorithm

Walks events in `ts` order. Two boring rules.

1. **Endpoint family** = the request path with the `/s/<sid>/` session prefix
   stripped, truncated to its first two segments. So
   `/s/default/v1/refunds` → `/v1/refunds` and
   `/s/default/v1/charges/ch_xxx` → `/v1/charges`. Different families never
   share a step.
2. **Step boundary** triggers on either:
   - the family of the current event differs from the family of the previous
     event, *or*
   - the gap from the previous event's `ts` exceeds `gapMs` (default 500 ms).

Within a step, lanes group events by `(method, family)`. Each lane carries
the `request_id`s of its events in time order.

Step IDs are deterministic: `stp_h00`, `stp_h01`, … (the `h` prefix marks
the heuristic path so adapter-rich step IDs cannot collide). Lane IDs are
`ln_h<step>_<lane>` with two-digit zero-padding.

## Output shape

Returns `{ lanes: Lane[], steps: Step[] }` matching the schemas exported from
`@pome-sh/shared-types`. `Step.lane_ids` and `Lane.step_id` are the join keys;
`Lane.request_ids` references back into the source `events.jsonl` by
`RecorderEvent.request_id` (events remain the source of truth).

## Uncorrelated lane (adapter-rich only)

Events that can't be assigned to any step (e.g. recorded before the first step
signal, or after the last one with no trailing event) land in a synthetic
"uncorrelated" lane under a synthetic step `stp_uncorrelated`. The correlator
never drops events on the floor.

The heuristic path does not need an uncorrelated bucket — every event is
assigned to a step by the family/gap rules.

## License

Apache-2.0. Part of the [pome](https://github.com/pome-sh/pome) OSS upstream.
