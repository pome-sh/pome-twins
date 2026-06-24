---
"pome-sh": patch
---

**CLI polish batch — F1, F6, F7, F8, F27, F28.**

- **F1 (`examples/triage-agent` loading indicator)**: the Claude Agent SDK can fall silent for 3–10s between assistant / tool_use messages; first-time users assumed the agent had hung. Added a 1-second `· thinking… Ns` tick to stderr that resets on each emitted message. Detects TTY — when piping to a log file or CI tail, each tick prints a fresh line instead of carriage-return rewriting, so scrollback stays readable.

- **F6 (real `git_sha` / `build_time` in `pome health`)**: `scripts/copy-prompts.mjs` now writes `dist/build-info.json` during `bun run build`, baking the resolved git SHA (CI `POME_GIT_SHA` / `GITHUB_SHA` / `git rev-parse HEAD` / "dev" fallback) and the ISO `build_time`. `cli/src/twin-github/build-info.ts` reads the file at runtime, with the existing env-var overrides still winning so hosted twins can stamp values via process env.

- **F7 (`agentSlug` documented)**: CLI reference docs now mention both `agentId` AND `agentSlug` for `pome register agent` — both are load-bearing (dashboard composes per-agent deep-links from the slug). Added a `pome session list` row covering the new `--state` flag.

- **F8 (`pome init` next-steps mentions Stripe + `--sdk claude`)**: the post-init message now lists two optional follow-ups — `pome init --sdk claude` (gated on `@pome-sh/adapter-claude-sdk` npm publish, Stage 1) and `pome scenarios stripe --copy` (Stage 2). Users with non-GitHub workloads now have a breadcrumb instead of a dead-end.

- **F27 (`pome <group> --help` lists sub-commands)**: added `.description()` strings to every `session` subcommand (`create`, `list`, `stop`). Commander v14 omits the "Commands:" block from a group's help text when its subcommands lack descriptions; the `register`, `twin`, `skills` groups already had per-subcommand descriptions and worked correctly. Verified `pome session --help` now lists `create`, `list`, and `stop|kill` with their one-liners.

- **F28 (`pome twin start` unauth healthz hint)**: standalone twin output now ends with `Health check (no auth): curl http://127.0.0.1:<port>/healthz`. Every `/s/<sid>/*` endpoint requires a Bearer JWT (including `/s/standalone/healthz`); users curling the printed `${restUrl}` were getting 401 and assuming the twin was broken. The root `/healthz` is unauth — print that instead.
