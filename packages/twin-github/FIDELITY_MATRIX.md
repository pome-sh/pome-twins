# GitHub Twin Fidelity Matrix

Last verified: 2026-07-12

| Surface | Heat | Tier | Contract |
| --- | --- | --- | --- |
| `GET /repos/:owner/:repo` | hot | semantic | Repository shape and 404 errors match the supported REST subset. |
| `POST /user/repos` | hot | semantic | Creates a repository with deterministic README and main branch. |
| `POST /orgs/:owner/repos` | hot | semantic | Org-owned repository creation; same semantics as `/user/repos`. |
| `POST /repos/:owner/:repo/forks` | hot | semantic | Copies repository, files, and commits into the fork owner or organization. |
| `GET /repos/:owner/:repo/issues` | hot | semantic | State, labels, assignees, pagination, and filters are clone-backed. |
| `POST /repos/:owner/:repo/issues` | hot | semantic | Creates persistent issues with GitHub-shaped labels and assignees. |
| `GET /repos/:owner/:repo/issues/:number` | hot | semantic | Reads persisted issue state and returns GitHub-style 404. |
| `PATCH /repos/:owner/:repo/issues/:number` | hot | semantic | Mutates title/body/state/labels/assignees and records state mutation. |
| `GET /repos/:owner/:repo/issues/:number/comments` | hot | semantic | Lists persisted issue comments with pagination. |
| `POST /repos/:owner/:repo/issues/:number/comments` | hot | semantic | Creates persistent issue comments. |
| `PATCH /repos/:owner/:repo/issues/comments/:comment_id` | hot | semantic | Updates issue comment body and `updated_at`. |
| `DELETE /repos/:owner/:repo/issues/comments/:comment_id` | hot | semantic | Deletes issue comment; 404 for unknown id. |
| `GET /repos/:owner/:repo/labels` | hot | semantic | Lists repository labels with deterministic local IDs. |
| `POST /repos/:owner/:repo/labels` | warm | semantic | Creates labels; color validation is intentionally permissive. |
| `GET /repos/:owner/:repo/issues/:number/labels` | hot | semantic | Returns the current issue label set. |
| `POST /repos/:owner/:repo/issues/:number/labels` | hot | semantic | Missing labels return GitHub-shaped 422s. |
| `DELETE /repos/:owner/:repo/issues/:number/labels/:name` | hot | semantic | 404 when removing a label the issue does not carry. |
| `POST /repos/:owner/:repo/issues/:number/assignees` | hot | semantic | Requires seeded collaborators. |
| `GET /repos/:owner/:repo/collaborators` | hot | semantic | Lists seeded collaborators as GitHub user objects. |
| `GET /repos/:owner/:repo/collaborators/:username` | hot | semantic | Returns `204` for present collaborators and `404` for absent users. |
| `PUT /repos/:owner/:repo/collaborators/:username` | warm | semantic | Creates invitation (201) for new users; returns 204 for existing collaborators. |
| `GET /repos/:owner/:repo/pulls` | hot | semantic | Lists pull requests with supported state and pagination filters. |
| `POST /repos/:owner/:repo/pulls` | hot | semantic | Creates clone-backed PRs from existing branches. |
| `PATCH /repos/:owner/:repo/pulls/:number` | hot | semantic | Title/body/state/base mutations; recomputes PR files on base change. |
| `GET /repos/:owner/:repo/pulls/:number/*` | hot | semantic | Supported PR detail, files, reviews, comments, status, merge, and update-branch routes are stateful; update-branch performs a semantic merge of base into head (F-735). |
| `GET /repos/:owner/:repo/pulls/:number/commits` | hot | semantic | Oldest-first commit walk between base_sha..head_sha. |
| `GET /repos/:owner/:repo/pulls/:number/diff` | hot | shape | Unified-diff-shaped envelope; patches are simplified placeholders. Hot gap, deferred post-M5 (F-729 G1). |
| `POST /repos/:owner/:repo/pulls/:number/comments` | hot | semantic | Creates inline review comments; 422 if path is not in the PR. |
| `POST /repos/:owner/:repo/pulls/:number/comments/:comment_id/replies` | hot | semantic | Reply inherits path/line/side/commit_sha from parent. |
| `GET /repos/:owner/:repo/branches` | hot | semantic | Branch list with pagination. |
| `GET /repos/:owner/:repo/branches/:branch` | hot | semantic | Single branch with commit pointer. |
| `DELETE /repos/:owner/:repo/git/refs/heads/:branch` | hot | semantic | 422 on default branch or branch backing an open PR. |
| `POST /repos/:owner/:repo/git/refs` | hot | semantic | Creates a branch ref from an existing SHA or branch head. |
| `GET /repos/:owner/:repo/contents/*` (READ) | hot | semantic | Existing GET preserved. |
| `PUT /repos/:owner/:repo/contents/*` (CREATE/UPDATE) | hot | semantic | Existing PUT preserved. |
| `DELETE /repos/:owner/:repo/contents/*` | hot | semantic | Requires `sha`; advances branch head with deletion commit. |
| `GET /repos/:owner/:repo/commits` | hot | semantic | Branch-scoped ancestry walk with pagination. |
| `GET /repos/:owner/:repo/commits/:ref` | hot | semantic | Single commit with stats and file_versions. |
| `GET /repos/:owner/:repo/compare/:basehead` | warm | shape | First-parent ancestry; status=ahead/behind/identical/diverged. |
| `POST /repos/:owner/:repo/statuses/:sha` | hot | semantic | Append-only commit statuses with 404 if SHA not in repo. |
| `GET /repos/:owner/:repo/commits/:ref/status` | hot | semantic | Combined-status rule applied across recorded statuses. |
| `POST /repos/:owner/:repo/check-runs` | hot | semantic | 422 if `status=completed` without `conclusion`. |
| `GET /repos/:owner/:repo/commits/:ref/check-runs` | hot | semantic | Most-recent-started-first; pagination. |
| `GET /repos/:owner/:repo/milestones` | warm | semantic | State filter + pagination. |
| `POST /repos/:owner/:repo/milestones` | warm | semantic | 422 on duplicate title. |
| `PATCH /repos/:owner/:repo/milestones/:number` | warm | semantic | Closes/reopens with `closed_at` bookkeeping. |
| `DELETE /repos/:owner/:repo/milestones/:number` | warm | semantic | 404 on unknown milestone. |
| `GET /repos/:owner/:repo/tags` | hot | semantic | Tag → commit SHA. |
| `GET /repos/:owner/:repo/releases` | hot | semantic | Newest-first; includes drafts. |
| `GET /repos/:owner/:repo/releases/latest` | hot | semantic | Skips drafts and prereleases. |
| `GET /repos/:owner/:repo/releases/tags/:tag` | hot | semantic | Release lookup by tag name; 404 for unknown tag (F-735). |
| `POST /repos/:owner/:repo/releases` | warm | semantic | Auto-creates tag from `target_commitish` if missing. |
| `GET /user` | hot | semantic | Returns JWT-claimed `login`. |
| `GET /search/*` | hot | semantic | Searches clone state for repositories, code, commits (F-735), issues, and users. |
| `POST /mcp/call` and `POST /mcp/tools/:name` | unclassified | semantic | MCP tools mutate the same state as REST routes. Engine introspection — outside the rubric's inventory scope; rows retained until the post-F-440 surface-count reconcile. |
| `GET /repos/:owner/:repo/actions/*` | cold | unsupported | Named cold (F-729): loud 501, test-backed (`m5-hot-gaps.test.ts`); top post-M5 promotion candidate. |
| `GET /repos/:owner/:repo/git/trees/:sha` | cold | unsupported | Named cold (F-729): git plumbing stays loud 501, test-backed. |
| `GET /orgs/:org/teams` | cold | unsupported | Named cold (F-729 G5): single-actor sandbox; vendor default-on disagreement recorded. |
| `GET /repos/:owner/:repo/issues/:number/sub_issues` | cold | unsupported | Named cold (F-729 G5): loud 501, test-backed. |
| `GET /orgs/:org/issue-types` | cold | unsupported | Named cold (F-729 G5): loud 501, test-backed. |
| Any unsupported path | cold | unsupported | Returns loud `501` with supported surfaces instead of empty `200` or random `500`. |
