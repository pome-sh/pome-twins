---
"pome-sh": patch
---

**F29 (CLI half) — wrap `pome compile-seeds --hosted` 502 with a friendly message.**

Before this change, a 502 from `POST /v1/scenarios/compile-seed` surfaced the raw Vercel AI Gateway error verbatim — including a `vercel.com/d?to=...` link and the phrase "Free tier users do not have access to this model, including via BYOK." Two problems with that: (1) leaks vendor internals into user-facing CLI output, (2) tells the user nothing actionable.

Now special-cases status 502 in `cli/src/scenario/seed-compiler-hosted.ts:throwForStatus` and throws a `HostedOrchError` with:

> Pome's hosted seed compiler hit a temporary capacity limit. Drop `--hosted` (or set ANTHROPIC_API_KEY then re-run `pome compile-seeds --force`) to compile locally via BYOK, or retry in a minute.

Cloud-side capacity remediation (upgrade Vercel AI Gateway plan / pick a free-tier-friendly model) is tracked as launch readiness L10 and out of CLI scope.

Regression test asserts the wrap hides `vercel.com` and "Free tier users" substrings and surfaces the actionable hint.
