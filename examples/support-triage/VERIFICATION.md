# Verification — the self-fix flip on `duplicate-issue`

Empirically measured on Pome, scored from the live twin tape (`provenance: hosted`),
on team **AFFF's workspace**. Runs are visible on `app.pome.sh`.

## Setup

- **Two distinct agents** — each version is registered separately, so its scores
  accumulate under its own identity (not conflated):
  - `support-triage-v1` (baseline) — a distinct Pome agent (id redacted; the
    committed-manifest convention keeps `agt_` ids out of the repo)
  - `support-triage-v2` (fixed) — a second distinct Pome agent (id redacted)
- **Scenario**: `duplicate-issue` (saved as `support-triage-dedup`,
  `task_OJue2tyNX-EpAoAC3k51`). Seed pre-loads open issue #1 for the coupon bug;
  `#support` gets a *new* report of the *same* bug.
- **Examinee runtime**: Claude managed agent on Anthropic's Managed Agents cloud,
  assembled from `run_scenario`'s `examinee_launch` (network clamped to
  `twins.pome.sh`, `web_search`/`web_fetch` off, `always_allow` on every
  `mcp_toolset`, a vault `static_bearer` per twin URL). Ephemeral per trial —
  torn down after each `finalize_run`.
- **Examinee model**: `claude-sonnet-5` for **both** versions (same model, one-line
  delta). Sonnet was chosen deliberately — this bug is the mirror image of a
  prompt-injection demo: the *failure* is prompt-driven ("don't search, just
  file") and reproduces on any model, but the *fixed* path needs a model capable
  of reliably running search → match → comment → link. A weak model (haiku) files
  the duplicate reliably but only deduped ~2/5 of the time on the fixed prompt; a
  mid model (sonnet) makes the fixed side reliable.
- **The two prompts** differ by exactly one line
  (`diff agents/support-triage-v1.yaml agents/support-triage-v2.yaml`): the
  search-before-filing line.
- **Trials**: 5 per version, each finalized the instant the examinee idled.

## Result

| Version | Pass rate | Score (per trial) | Behavior |
|---|---|---|---|
| **v1** (baseline) | **0 / 5** | 33 · 33 · 33 · 33 · 33 | Did not search; filed a duplicate issue #2 and posted its link — a second issue for a bug already tracked. |
| **v2** (fixed) | **4 / 5** | 100 · 33 · 100 · 100 · 100 | Searched, found issue #1, commented on it, posted issue #1's link to #support — no duplicate. One trial still filed a duplicate. |

The v1 runs score **33**, not 0, because one criterion — *the report contains
concrete repro steps* — is independent of the dedup decision and passes in every
run; v1 writes a good bug report, it just files it as a duplicate. The dedup
decision flips the other two criteria:

| criterion | kind | v1 | v2 |
|---|---|---|---|
| a `#support` message links `issues/1` | code:slack | ✗ | ✓ (4/5) |
| recognized the existing issue, opened no duplicate | model | ✗ | ✓ (4/5) |
| concrete repro steps | model | ✓ | ✓ |

State-diff at a glance: v1 leaves `issues: 1 → 2` (a duplicate); v2 leaves
`issues: 1 → 1` plus a comment on #1.

**Honest caveat.** v2 is 4/5, not 5/5. This dedup task carries ~20% agent
variance — occasionally the agent files a fresh issue despite the search-first
instruction. 0/5 vs 4/5 is a clear, reproducible flip, but the fixed side is not
pristine; a stronger model may or may not remove the last flake.

## Runs (all `provenance: hosted`, judge `google/gemini-2.5-flash`)

**v1 — 5/5 failed (33):**
- run_nrtQJdyqtmYwANuQ · run_zpqvU0PuwlU6sGfA · run_HaOqog6gNvchuuir · run_OoTjQHcn25uGdaKE · run_xbl1LQTjc57aDl1M

**v2 — 4/5 passed (100), 1 flake (33):**
- run_KYvIpLTuWoyL6SXK (100) · run_kUCZmKAcit5NWzxo (100) · run_Syq8A26s0LEWsMPP (100) · run_aeYs6ZadKLHvxNWp (100) · run_m8CpN9FecymhiSHM (33, flake)

`https://app.pome.sh/runs/<run_id>` for any of them.

## Reproduce

1. Register two agents on Pome: `register_agent(name="support-triage-v1",
   twins=["github","slack"])` and the same for `-v2`.
2. For each, `run_trials(scenario_id, agent_id, n=5)`; assemble each trial's
   clone from `examinee_launch` (env clamp, vault `static_bearer` per twin URL,
   `always_allow` on every `mcp_toolset`, web tools off), model
   `claude-sonnet-5`, `system` = that version's prompt; kick off with
   `examinee_task.prompt`.
3. Poll the managed-agent session to idle, then `finalize_run(session_id,
   agent_token)` immediately (tape is pulled from the still-live twin session).
4. The two versions differ by one line — `agents/support-triage-v1.yaml` vs
   `agents/support-triage-v2.yaml`.
