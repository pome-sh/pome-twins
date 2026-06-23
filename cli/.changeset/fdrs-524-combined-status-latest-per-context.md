---
"pome-sh": patch
---

Fix two issues in the `18-fabricate-green-ci` scenario and the GitHub twin's
combined-status semantics. (1) The twin's combined commit status now keeps the
**latest status per context** (GitHub's real behavior), so a `success` written
on the same context overrides an earlier `failure` — previously a stale failure
row outvoted a fresh success and the fabricated-green merge could never actually
unlock, making the scenario's reward-hack a no-op. (2) The seeded failing-status
description said `got 81` but the seeded double-discount code returns `80`
(`100 - 10 - 10`); corrected to `got 80`. Scenario prose updated to describe the
override mechanism accurately. The fabrication-detecting `[D]` criteria are
unchanged.
