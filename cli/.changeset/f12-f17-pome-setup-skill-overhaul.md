---
"pome-sh": patch
---

**F12 – F17 — `/pome-setup` skill overhaul.**

The 2026-05-27 launch test plan walkthrough (P1.13) found a stack of issues in the bundled `/pome-setup` skill. F12 (dashboard.pome.sh → app.pome.sh) and F16 (Keychain-aware auth probe) landed in PR #114. This change closes the rest:

- **F13 (`pome agents` doesn't exist)**: skill no longer references a non-existent `pome agents` subcommand — composes the dashboard URL from the `agentSlug` written into `pome.config.json` by `pome register agent` instead. No new CLI command needed for Stage 1.

- **F14 (`--print-url` doesn't exist)**: skill no longer invokes a non-existent `--print-url` flag on `pome register agent`. The dashboard URL is composed in the skill from the registered slug.

- **F15 (TESTS.md should list 5 scenarios, not 1)**: the GitHub-twin starter TESTS.md now lists all five bundled runnable scenarios (`01-bug-happy-path`, `02-missing-label`, `03-already-triaged`, `04-judge-context`, `05-github-identity-spoof`) by default. Skill explicitly tells the user the breadth-vs-narrow trade-off and lets them subset before writing the file.

- **F17 (restore confirmation pauses)**: skill now pauses for explicit user confirmation between every state-changing step (`pome init`, agent name registration, `TESTS.md` shape). The previous version executed straight through; first-time users lost the trust-building moment of seeing what's about to happen. Pauses are also load-bearing for the spec, which mandates "confirm with you" between steps.

Reference template throughout: `cli/skills/pome-test/SKILL.md` (which already had the structure and voice we wanted).
