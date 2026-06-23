---
"pome-sh": patch
---

**F0-5 / L8 / F18 (CLI half) — exit-code contract honored across `pome run`'s pre-flight and post-finalize paths.**

The 2026-05-27 launch test plan (P2.24–27, P1.14) found three paths returning the wrong documented exit code:

- **F0-5a**: `pome run /does/not/exist.md` → exit 2 (twin/orch) instead of 5 (usage).
- **F0-5c**: `pome logout && pome run …` → exit 2 instead of 3 (auth).
- **F18 / F0-5b**: hosted sub-threshold run with a non-zero-exiting agent → exit 3 instead of 1 (below-threshold). Reproducer: `01-bug-happy-path.md` against a Claude+Octokit agent in `/tmp/pome-skill-test`, 50/100 cloud score, `$? = 3`.

Root causes (Session A audit FDRS-423 confirmed all three are CLI-side):

1. `scenarioFiles()` threw a plain `Error` when the path was missing; Commander's top-level catch demoted to exit 2.
2. `resolveCredentials()` threw a plain `Error` with the "Hosted mode requires authentication" message when no Keychain / file / `POME_API_KEY` matched; same demotion path.
3. `runScenarioHosted.ts` mapped `agentResult.exitCode !== 0 || agentResult.timedOut` to `exitCode = 3`. That stole the documented auth slot for a non-auth condition AND overrode the cloud-judged score on sub-threshold runs.

CLI changes:

- Added `HostedUsageError` to `cli/src/hosted/errors.ts`. `exitCodeFor()` now maps it to exit 5; `HostedAuthError`/`HostedQuotaError`/`HostedOrchError` mappings unchanged.
- `cli/src/cli/main.ts`'s `scenarioFiles()` throws `HostedUsageError` on missing paths. The `run` action's pre-flight (file resolution + credential resolution) is now wrapped in try/catch that maps via `exitCodeFor`; previously these threw to Commander's `process.exitCode = 2` fallback.
- `cli/src/cli/credentials.ts` throws `HostedAuthError` (not plain `Error`) on the "no creds anywhere" branch.
- `cli/src/runner/runScenarioHosted.ts` drops the "agent failure trumps score" rule. Once `/finalize` has returned, the cloud-judged score is authoritative; `exitCode = score >= passThreshold ? 0 : 1`. Pre-finalize failures (auth / quota / twin spawn / exec errors) still throw the typed errors and never reach this line.

Regression tests:

- `test/unit/hosted/errors.test.ts` asserts the full 0/1/2/3/4/5 mapping including the new `HostedUsageError → 5`.
- `test/unit/credentials.test.ts` asserts `resolveCredentials` rejects with `HostedAuthError` when no Keychain / file / `POME_API_KEY` are available (F0-5c).
- `test/integration/runScenarioHosted.test.ts` timeout case updated: a timed-out agent with a 0/100 score now returns exit 1 (below-threshold), not exit 3 (which was the F18 misbehavior).
