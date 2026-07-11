# GitHub Twin Fidelity

`@pome-sh/twin-github` is a high-fidelity test double of GitHub — not a
universal clone. This page documents exactly which surfaces are faithful to
GitHub today, at what tier, and how fidelity is verified.

Last verified: 2026-05-27.

## What "fidelity" means here

Each MCP tool and REST route is classified into one of three tiers:

- **`semantic`** — the stateful behavior is implemented locally and covered
  by tests. Optimistic locking, branch ancestry, label invariants, and the
  rest behave the way agents expect when they call real GitHub.
- **`shape`** — the response shape is checked against captured real GitHub
  fixtures, but the underlying behavior is not fully semantic. Useful for
  agents that only inspect the response shape; not safe for agents that
  rely on the side effects.
- **`unsupported`** — not implemented. The clone returns a loud 501 envelope
  (see below) so an agent never silently succeeds against a missing route.

Fidelity ("how deep a surface *is*") is one of two orthogonal dimensions; the
other is **heat** ("how deep it *should* be", `hot`/`warm`/`cold`, ruled per
milestone). The engine-level rubric — tier criteria, target mapping, gap and
tier-mismatch semantics — lives at
[`packages/sdk/ENDPOINT-TIERS.md`](../sdk/ENDPOINT-TIERS.md). The `Tier`
column below means fidelity.

The bar Pome aims for is: **agents written against real GitHub run unchanged
against the local twin for the surfaces below**, and trip a loud failure for
anything outside them.

For the build / runtime / cloud consumer invariants the hosted snapshot build
depends on (port `:3333`, `/healthz`, `GITHUB_CLONE_HOST`, `npm install`-able
package, `node dist/src/server.js`), see
[Runtime contract (for snapshot consumers)](README.md#runtime-contract-for-snapshot-consumers)
in the package README. Changing any of those is a breaking change for
`pome-cloud` and requires a matching cloud consumer PR.

## MCP Tools

| Tool | Backing surface | Tier | Tests | Known deviations |
| --- | --- | --- | --- | --- |
| `search_repositories` | SQLite repositories | semantic | `mcp-contract.test.ts`, `fixture-shape.test.ts` | Search query support is intentionally smaller than GitHub search syntax. |
| `create_repository` | SQLite repositories, branches, commits, files | semantic | `mcp-contract.test.ts`, `concurrency.test.ts` | Creates a deterministic README and main branch. |
| `fork_repository` | SQLite repository/file/commit copy | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Fork permissions and network metadata are simplified. |
| `get_repository` | SQLite repositories | semantic | `mcp-contract.test.ts`, `fixture-shape.test.ts` | Repository object contains the fields agents use, not every GitHub field. |
| `search_code` | SQLite default-branch files | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `performance.test.ts` | Query syntax is substring based; search is scoped to the default branch. |
| `search_users` | SQLite users | semantic | `mcp-contract.test.ts` | Organization/user scoring is simplified. |
| `get_file_contents` | SQLite files/directories | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `fixture-shape.test.ts` | Symlinks, submodules, and media/raw modes are not implemented. |
| `list_commits` | SQLite commit graph | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `fixture-shape.test.ts` | Commit listing follows the selected branch ancestry only. |
| `create_or_update_file` | SQLite files/commits | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Requires `sha` for updates to preserve optimistic locking. |
| `create_branch` | SQLite branches/files | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `concurrency.test.ts` | Branch protection is not modeled. |
| `push_files` | SQLite files/commits | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Multi-file pushes are one local commit; Git object APIs are simplified. |
| `get_issue` | SQLite issues | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Issue timeline/events are not modeled. |
| `update_issue` | SQLite issues, labels, assignees | semantic | `mcp-contract.test.ts`, `mcp-error-semantics.test.ts` | Milestones/projects are not implemented. |
| `search_issues` | SQLite issues | semantic | `mcp-contract.test.ts`, `performance.test.ts`, `fixture-shape.test.ts` | Query syntax is substring based. |
| `list_issues` | SQLite issues | semantic | `mcp-contract.test.ts`, `performance.test.ts`, `fixture-shape.test.ts` | Only state, labels, assignee, and pagination filters are supported. |
| `add_issue_comment` | SQLite issue comments | semantic | `mcp-contract.test.ts`, `state-export.test.ts` | Comment edit/delete APIs are not implemented. |
| `list_issue_comments` | SQLite issue comments | semantic | `mcp-contract.test.ts`, `state-export.test.ts` | Pagination is supported; reactions are not. |
| `create_issue` | SQLite issues | semantic | `mcp-contract.test.ts` | Issue templates and milestones are not modeled. |
| `list_repository_labels` | SQLite labels | semantic | `mcp-contract.test.ts` | Label URLs use deterministic local IDs. |
| `create_label` | SQLite labels | semantic | `mcp-contract.test.ts` | Color validation is intentionally permissive. |
| `list_issue_labels` | SQLite issue labels | semantic | `mcp-contract.test.ts` | Returns current issue label set only. |
| `add_issue_labels` | SQLite issue labels | semantic | `mcp-contract.test.ts` | Missing labels return GitHub-shaped 422s. |
| `remove_issue_label` | SQLite issue labels | semantic | `mcp-contract.test.ts` | Removing a missing label returns 404. |
| `list_collaborators` | SQLite collaborators | semantic | `mcp-contract.test.ts` | Permission filtering is not implemented. |
| `add_assignees` | SQLite issue assignees | semantic | `mcp-contract.test.ts` | Requires seeded collaborators. |
| `get_pull_request` | SQLite pull requests | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Drafts, mergeability background jobs, and review decisions are simplified. |
| `get_pull_request_reviews` | SQLite PR reviews | semantic | `mcp-contract.test.ts`, `state-export.test.ts` | Review dismissal is not implemented. |
| `create_pull_request_review` | SQLite PR reviews | semantic | `mcp-contract.test.ts`, `state-export.test.ts` | Inline review comments are not created by this tool. |
| `get_pull_request_comments` | SQLite PR review comments | semantic | `mcp-contract.test.ts` | Review comment creation is not exposed yet. |
| `get_pull_request_files` | SQLite computed PR files | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Patches are simplified placeholders. |
| `get_pull_request_status` | SQLite commit statuses | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Check suites and check runs are not modeled. |
| `list_pull_requests` | SQLite pull requests | semantic | `mcp-contract.test.ts` | Sorting and advanced filters are simplified. |
| `merge_pull_request` | SQLite merge mutation | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Merge methods are simplified to one deterministic local merge. |
| `update_pull_request_branch` | SQLite branch head update | shape | `mcp-contract.test.ts`, `domain.test.ts` | Updates the local branch pointer and response shape, but does not create GitHub's merge commit or async update job. |
| `create_pull_request` | SQLite pull requests/files | semantic | `mcp-contract.test.ts`, `concurrency.test.ts` | Cross-repo forks are supported only when the fork exists in the clone. |
| `list_branches` | SQLite branches | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Pagination supported; protection metadata always false. |
| `get_branch` | SQLite branches | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Returns shape-compatible commit object with head SHA. |
| `delete_branch` | SQLite branches/files | semantic | `mcp-contract.test.ts`, `domain.test.ts` | 422 on default branch or branch backing an open PR; cascades file rows. |
| `delete_file` | SQLite files/commits | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Requires `sha` for optimistic locking; advances branch head atomically. |
| `get_commit` | SQLite commits/file_versions | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Resolves ref by SHA, branch, or tag. Stats/files reflect file_versions diff. |
| `compare_commits` | SQLite commits (ancestry walk) | shape | `mcp-contract.test.ts`, `domain.test.ts` | First-parent ancestry only; capped at `MAX_COMPARE_DEPTH=2000`; merge-base is approximated. |
| `get_pull_request_diff` | SQLite pull_request_files | shape | `mcp-contract.test.ts`, `domain.test.ts` | Returns a unified-diff-shaped envelope; patches are simplified placeholders. |
| `update_pull_request` | SQLite pull requests | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Updates title/body/state/base; recomputes PR files on base change; cannot reopen a merged PR. |
| `get_pull_request_commits` | SQLite commits walk | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Oldest-first ordering between base_sha..head_sha. |
| `create_pull_request_review_comment` | SQLite PR review comments | semantic | `mcp-contract.test.ts`, `domain.test.ts` | 422 if path is not part of the PR; line/side stored. |
| `add_reply_to_pull_request_comment` | SQLite PR review comments | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Inherits path/line/side from parent comment; sets `in_reply_to_id`. |
| `update_issue_comment` | SQLite issue comments | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Updates body and `updated_at`. |
| `delete_issue_comment` | SQLite issue comments | semantic | `mcp-contract.test.ts`, `domain.test.ts` | 404 on unknown comment. |
| `list_milestones` | SQLite milestones | semantic | `mcp-contract.test.ts`, `domain.test.ts` | State filter (`open`/`closed`/`all`) + pagination supported. |
| `create_milestone` | SQLite milestones | semantic | `mcp-contract.test.ts`, `domain.test.ts` | 422 on duplicate title; default state is `open`. |
| `update_milestone` | SQLite milestones | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Closing sets `closed_at`; reopening clears it. |
| `delete_milestone` | SQLite milestones | semantic | `mcp-contract.test.ts`, `domain.test.ts` | 404 on unknown milestone. |
| `create_commit_status` | SQLite commit_statuses | semantic | `mcp-contract.test.ts`, `domain.test.ts` | 404 if SHA not in repo; default context is `default`. |
| `get_combined_status_for_ref` | SQLite commit_statuses | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Combined state follows GitHub rule; empty status set returns `pending`. |
| `create_check_run` | SQLite check_runs | semantic | `mcp-contract.test.ts`, `domain.test.ts` | 422 if `status=completed` without `conclusion`; no check_suites modeled. |
| `list_check_runs_for_ref` | SQLite check_runs | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Pagination supported; ordered most-recent-started first. |
| `list_tags` | SQLite tags | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Returns tag → commit SHA; tarball/zipball URLs are shaped placeholders. |
| `list_releases` | SQLite releases | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Newest-first; includes drafts and prereleases. |
| `get_latest_release` | SQLite releases | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Skips drafts and prereleases; 404 if none. |
| `create_release` | SQLite releases/tags | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Auto-creates the tag from `target_commitish` if missing; 422 on duplicate tag. |
| `get_me` | SQLite users + JWT actor | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Returns the JWT-claimed `login` (default `pome-agent`). |
| `add_collaborator` | SQLite collaborators | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Returns 201 invitation envelope for new users; 204 for existing collaborators. |

## REST Surfaces

The REST routes used by the MCP tools are also exposed under authenticated
`/s/:sid/*` paths. Captured fixture checks currently cover repository search,
issue search, contents, commits, and issue lists as `shape` tests. All
unsupported routes return a loud 501 envelope:

```json
{
  "message": "This endpoint is not supported by this GitHub twin clone.",
  "_twin": {
    "fidelity": "unsupported",
    "supported_surfaces": [
      "GitHub-shaped REST",
      "POST /s/:sid/mcp",
      "GET /s/:sid/mcp/tools",
      "POST /s/:sid/mcp/tools/:name",
      "POST /s/:sid/mcp/call"
    ]
  }
}
```

Twin-only fields are namespaced under `_twin.*`, matching `twin-slack` and
`twin-stripe`.

If you hit this envelope and the route is one your agent needs, that's a
fidelity gap worth filing — open an issue or a PR adding the route.

## Known divergences from real GitHub

These are the cross-cutting behaviors where the twin deliberately or
provisionally differs from real GitHub. Each bullet has a structured entry in
the Twin Fidelity Watch's `known-divergences/github.yaml` (maintained in
pome-cloud); a lint keeps the two 1:1. The fidelity watchdog reverse-tests each one against
upstream so a divergence that upstream "heals" becomes a tier-upgrade signal.

1. **Search query syntax is substring-based.** `search_repositories`,
   `search_code`, and `search_issues` use substring matching scoped to the
   default branch — GitHub's search qualifiers (`in:`, `language:`, `path:`,
   boolean operators) are not parsed.
2. **PR diffs and patches are simplified placeholders.** `get_pull_request_diff`
   and `get_pull_request_files` return a unified-diff-shaped envelope whose
   `patch` bodies are placeholders, not byte-accurate GitHub patches.
3. **`compare_commits` walks first-parent ancestry only.** Comparison follows
   first parents, is capped at `MAX_COMPARE_DEPTH=2000`, and approximates the
   merge-base rather than computing GitHub's exact three-dot base.
4. **Branch protection is not modeled.** `list_branches` / `get_branch` always
   report protection metadata as `false`; protected-branch push rejections and
   required-status-check gating do not exist in the twin.
5. **User objects are a documented subset of real GitHub fields.** The twin's
   user object carries the fields agents use (`login`, `id`, `node_id`,
   `avatar_url`, `html_url`, `type`, `site_admin`) and omits always-present
   real-GitHub profile leaves: `gravatar_id`, `user_view_type`, and the optional
   `hireable` / `twitter_username` / `notification_email` on `GET /user`. User
   objects embed all over the API (`owner`, `[].user`, commit `author`/`committer`,
   the PR-status `repository.owner`), so this divergence is registered once and
   matched by leaf key wherever the user object nests. On an L1 read surface an upstream-only leaf the twin omits is an
   accepted divergence (INFO), not drift — a twin returning a *subset* of GitHub's
   fields is faithful; a twin returning a field GitHub does not is still flagged.
6. **Repository objects are a documented subset of real GitHub fields.** The
   twin's repository object omits three families of always-present real-GitHub
   leaves: stat counts (`stargazers_count`, `watchers_count`, `forks_count`,
   `open_issues_count`, `network_count`, `subscribers_count`, `size`, ...),
   settings / merge flags (`has_*`, `allow_*`, `archived`, `disabled`,
   `is_template`, `delete_branch_on_merge`, the squash/merge commit settings,
   `pull_request_creation_policy`, ...), and metadata (`homepage`, `language`,
   `mirror_url`, `license`, `topics`, `visibility`, `permissions`,
   `temp_clone_token`, `custom_properties`, `organization`,
   `security_and_analysis`). Repo objects embed under `head.repo` / `base.repo` /
   `repository`; leaf-key matching covers every nesting. On an L1 read surface such
   an upstream-only omission is an accepted divergence (INFO), not drift.
7. **Collaborator objects omit per-collaborator permission metadata.**
   `GET /repos/:o/:r/collaborators` objects omit the per-collaborator `permissions`
   map and `role_name`: the twin does not model collaborator permission filtering.
   On an L1 read surface this upstream-only omission is an accepted divergence
   (INFO), not drift. Agents that branch on a collaborator's permission level
   should treat this surface as shape-only until the twin models it.
8. **Issue objects omit timeline/reaction/milestone metadata.** The twin's issue
   object omits `milestone`, `author_association`, `type`, `active_lock_reason`,
   `draft`, `pull_request`, `closed_by`, `reactions`, `performed_via_github_app`,
   `state_reason`, `issue_field_values`, `sub_issues_summary`,
   `issue_dependencies_summary`, `pinned_comment` (and the search-only `score` /
   `search_type`): timelines, reactions, milestones, and projects are not modeled.
   On an L1 read surface (`GET /repos/:o/:r/issues`, `.../issues/:n`,
   `GET /search/issues`) these upstream-only omissions are accepted (INFO), not drift.
9. **Commit objects omit comment-count and signature verification.** The twin's
   commit object omits the nested `commit.comment_count` and `commit.verification`
   (GPG signature) leaves: commit comments and signature verification are not
   modeled. On an L1 read surface (`GET /repos/:o/:r/commits`, `.../commits/:ref`,
   `.../compare/:basehead`, `.../pulls/:n/commits`) these are accepted (INFO), not drift.
10. **Branch objects omit protection and inlined commit detail.** The twin's branch
    object omits `protection` (branch protection is not modeled — see bullet 4) and,
    on the branch-detail surfaces, the full-commit leaves GitHub inlines (`node_id`,
    `commit`, `author`, `committer`, `parents`). On an L1 read surface
    (`GET /repos/:o/:r/branches`, `.../branches/*`) these upstream-only omissions are
    accepted (INFO), not drift.
11. **Pull-request objects omit assignee/review/mergeability metadata.** The twin's
    pull-request object omits `assignees`, `requested_reviewers`, `requested_teams`,
    `labels`, `auto_merge`, `author_association` and (on the detail surface)
    `mergeable`, `rebaseable`, `mergeable_state`, `merged_by`, `comments`,
    `review_comments`, `maintainer_can_modify`: mergeability jobs, review decisions,
    and label/assignee modeling are simplified. On an L1 read surface
    (`GET /repos/:o/:r/pulls`, `.../pulls/:n`) these upstream-only omissions are
    accepted (INFO), not drift.
12. **Pull-request `merge_commit_sha` is GitHub's ephemeral test-merge commit.**
    `merge_commit_sha` is the sha GitHub computes by speculatively merging the PR
    head into the base to test mergeability — non-deterministic and not a commit in
    either branch's history. The twin does not model that background job, so it
    returns `null` where real GitHub returns a transient sha. On an L1 read surface
    (`GET /repos/:o/:r/pulls`, `.../pulls/:n`) this is an accepted divergence (INFO),
    not drift — the twin cannot reproduce an ephemeral, GitHub-internal artifact.
13. **Issue `assignee` reflects the controlled-sandbox seed, not real GitHub.** The
    singular `assignee` is null on real GitHub for the seeded sandbox (the seed's
    route-A capture dropped the fictional assignees), while the twin returns its
    seeded assignee object. On an L1 read surface (`GET /repos/:o/:r/issues`,
    `.../issues/:n`) this seed-state difference is an accepted divergence (INFO), not
    drift — the twin faithfully reflects its own seeded assignment.
14. **`GET /user` is the seeded agent, not the golden's token owner.** `GET /user`
    returns the authenticated token owner; the upstream golden is the human token
    owner, the twin its seeded agent user. The identity leaves `blog` (real `""` vs
    twin `null`) and `email` (real `null` vs twin's seeded address) therefore differ.
    On this L1 read surface that is an accepted identity divergence (INFO), not drift.
15. **`search_users` `type` reflects the local seed, not GitHub's global result set.**
    `GET /search/users` against real GitHub is a global search whose items span real
    users and organizations, so the `type` enum holds both `"User"` and
    `"Organization"`. The twin searches only its local seed (the single user `alice`,
    `type "User"` — the same value real GitHub returns for that login), so the enum
    differs only because the local result set has no organizations. On this L1 read
    surface that is an accepted result-set divergence (INFO), not drift — not a wrong
    enum or casing in the serializer.
16. **`GET /issues` excludes PRs that real GitHub models as issues (genuine gap).** Real
    GitHub models pull requests as issues, so `GET /repos/:o/:r/issues` includes the
    repo's open PR (with a `pull_request` member) — 3 items where the twin returns 2. The
    twin's `/issues` excludes PRs; a faithful twin would include them. Fixing the twin is
    out of scope, but the array-aware oracle (FDRS-455) now SEES the item-count
    divergence: registered as accepted on the collection root so this L1 read surface is
    INFO, not drift, and flagged as a genuine twin-fidelity gap for follow-up.
17. **Issue `assignees`/`labels` arrays reflect the controlled-sandbox seed, not real GitHub.**
    The plural `assignees` and the `labels` arrays are non-empty on the twin (its seeded
    fictional assignee/label) but empty on real GitHub for the seeded sandbox — the same
    route-A seed-state cause as the singular `assignee` (bullet 13). On the issue read
    surfaces this array-length difference is an accepted divergence (INFO), not drift.
18. **`/search/*` result-set item counts reflect the local seed, not GitHub's global index.**
    A GitHub search is global (millions of matches, 30 per page); the twin searches only
    its local seed and returns the few local matches. The `items` count (and the per-item
    `labels` count inside a globally-returned issue) differ for the same global-vs-local
    result-set reason as the `search_users` `type` (bullet 15). On the `/search/*` read
    surfaces these length differences are accepted (INFO), not drift.
19. **Commit `parents`/`files` and commit-list counts reflect the seeded sandbox git history.**
    The commits-collection length, per-commit `parents` count (seeded commits are roots,
    0 vs 1), and per-commit `files` changed-set count differ because the seeded sandbox's
    git history is not a byte-for-byte mirror of the real repo's commit DAG. On the
    `GET /repos/:o/:r/commits`, `.../commits/:ref`, `.../compare/:basehead` read surfaces
    these length differences are accepted (INFO), not drift.
20. **`/labels` and `/collaborators` list counts reflect the seeded sandbox content.**
    The `/labels` (2 vs 10) and `/collaborators` (3 vs 2) collection counts reflect the
    seeded sandbox's smaller label set and different collaborator set, not a serializer
    bug. On these L1 read surfaces the item-count difference is an accepted divergence
    (INFO), not drift.

## How fidelity is verified

Three independent checks back the tier classifications above. Each is a
script you can run locally; CI runs coverage on every PR.

### 1. Captured fixture shape tests (`test/fixture-endpoints.test.ts`)

The repository keeps sanitized response-shape fixtures captured from real
GitHub via `gh api`. Tests under `packages/twin-github/test/fixture-endpoints.test.ts`
boot the local twin, hit the equivalent local routes, and assert the response
shape matches the captured fixture (keys present, types compatible, optional vs required
correct). Generated metadata (IDs, timestamps, URLs, SHAs) is allowed to
differ; behavior-shape is not.

Refresh the fixtures with `npm run capture:fixtures` when you have GitHub
CLI auth available. The fixture set is the contract.

### 2. MCP parity (`scripts/fidelity-parity.ts`)

`scripts/fidelity-parity.ts` exercises all 62 MCP tools end-to-end against
a freshly seeded local twin. It runs in two modes:

- **Local-only** — every tool is invoked locally; success means the contract
  surface is reachable and produces a well-typed response.
- **Live read-only** — set `GITHUB_PARITY_REPO=owner/repo` and the script
  additionally calls the same read-only endpoints on real GitHub via `gh
  api`, asserting that response shape parity holds for the live target too.

Run it: `npm run fidelity:parity`.

### 3. Cross-twin review harness (`scripts/review-harness.ts`)

`scripts/review-harness.ts` is a behavior harness — not a shape harness. It
runs three end-to-end agent flows that exercise the corner cases agents
usually trip on:

- `functional-pr-flow`: create repo → branch → file → PR → approve → merge →
  read merged file.
- `negative-fidelity`: missing file must fail; creating a file must succeed;
  stale `sha` update must fail.
- `concurrency-stress`: eight concurrent writes to the same path; exactly
  one create wins, the final file is readable.

Point it at the local twin (`REVIEW_TARGET=local`) and all three tests should pass.

See [`packages/twin-github/README.md`](README.md#review-harness) for auth model, MCP protocol shape, default seed, and error envelope details.

### Filing a fidelity bug

If you find a case where an agent's behavior diverges between real GitHub
and the local twin in a way the tables above don't predict, open an issue
with:

1. The MCP tool or REST route involved.
2. Minimal repro: the request, the local response, the GitHub response.
3. Whether the divergence is shape (keys/types differ) or semantic (state
   transition behaves differently).

That's exactly the input we use to upgrade a tool from `shape` to
`semantic`, or to add a new entry to **Known deviations** above.
