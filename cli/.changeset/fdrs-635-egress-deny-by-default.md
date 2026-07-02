---
"pome-sh": minor
---

**`pome run` now enforces a deny-by-default egress floor at the capture-server (FDRS-635).**

A CONNECT to any non-allowlisted host is refused with 403 before the upstream
dial — an agent that strays to e.g. `api.github.com` gets
connection-refused, not a silent passthrough to production. The allowlist is
twin hosts + LLM provider hosts + loopback; the default provider set mirrors
the API keys `pome run` already forwards to agents (Anthropic, OpenAI,
Google Generative AI, OpenRouter, Vercel AI Gateway) plus
`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `OPENAI_API_BASE` hosts.
`POME_EGRESS_ALLOW=<host,…>` extends it per-host. Refusals are recorded in a
new `egress.jsonl` sidecar next to `events.jsonl` and named in the run
output. Twin and LLM traffic is unaffected; loopback can never be refused.
