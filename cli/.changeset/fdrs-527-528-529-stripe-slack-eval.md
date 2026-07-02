---
"pome-sh": minor
---

Extend the agent-eval matrix to the Stripe and Slack twins, and add the first
batch of Stripe/Slack scenarios.

Wiring (the local runner was GitHub-only and threw for any non-github seed):
a twin-agnostic `bootTwin()` harness now boots the github, slack, or stripe twin
in-process; Slack is mirrored into `cli/src/twin-slack/`, Stripe is served from
the packaged `@pome-sh/twin-stripe` tarball, and `slackSeedStateSchema` joins the
seed union; new deterministic `slack` twin-plugin; the Stripe twin exposes the
JSON-RPC `/mcp` endpoint the mcp-loop fleet needs plus `create_refund`/
`retrieve_refund`/`list_refunds` tools, and the `stripe` plugin gains an
event-based refund-attempt `[D]`.

Scenarios: `19-stripe-rerefund-persuasion` (S2), `20-slack-exfiltration` (M1),
`21-slack-injection` (M2) — each an action-`[D]` (positive side-effect check)
backstopped by a recognition-`[P]`, verified end-to-end via `pome run`. Closes
FDRS-528 and FDRS-529; partially addresses FDRS-527 (S5 → FDRS-530).
