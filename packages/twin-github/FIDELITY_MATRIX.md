# GitHub Twin Fidelity Matrix

Last verified: 2026-05-27

| Surface | Tier | Contract |
| --- | --- | --- |
| `GET /repos/:owner/:repo` | semantic | Repository shape and 404 errors match the supported REST subset. |
| `GET /repos/:owner/:repo/issues` | semantic | State, labels, assignees, pagination, and filters are clone-backed. |
| `POST /repos/:owner/:repo/issues` | semantic | Creates persistent issues with GitHub-shaped labels and assignees. |
| `GET /repos/:owner/:repo/issues/:number` | semantic | Reads persisted issue state and returns GitHub-style 404. |
| `PATCH /repos/:owner/:repo/issues/:number` | semantic | Mutates title/body/state/labels/assignees and records state mutation. |
| `PATCH /repos/:owner/:repo/issues/comments/:comment_id` | semantic | Updates issue comment body and `updated_at`. |
| `DELETE /repos/:owner/:repo/issues/comments/:comment_id` | semantic | Deletes issue comment; 404 for unknown id. |
| `GET /repos/:owner/:repo/collaborators` | semantic | Lists seeded collaborators as GitHub user objects. |
| `GET /repos/:owner/:repo/collaborators/:username` | semantic | Returns `204` for present collaborators and `404` for absent users. |
| `PUT /repos/:owner/:repo/collaborators/:username` | semantic | Creates invitation (201) for new users; returns 204 for existing collaborators. |
| `GET /repos/:owner/:repo/pulls` | semantic | Lists pull requests with supported state and pagination filters. |
| `POST /repos/:owner/:repo/pulls` | semantic | Creates clone-backed PRs from existing branches. |
| `PATCH /repos/:owner/:repo/pulls/:number` | semantic | Title/body/state/base mutations; recomputes PR files on base change. |
| `GET /repos/:owner/:repo/pulls/:number/*` | semantic | Supported PR detail, files, reviews, comments, status, merge, and update-branch routes are stateful. |
| `GET /repos/:owner/:repo/pulls/:number/commits` | semantic | Oldest-first commit walk between base_sha..head_sha. |
| `GET /repos/:owner/:repo/pulls/:number/diff` | shape | Unified-diff-shaped envelope; patches are simplified placeholders. |
| `POST /repos/:owner/:repo/pulls/:number/comments` | semantic | Creates inline review comments; 422 if path is not in the PR. |
| `POST /repos/:owner/:repo/pulls/:number/comments/:comment_id/replies` | semantic | Reply inherits path/line/side/commit_sha from parent. |
| `GET /repos/:owner/:repo/branches` | semantic | Branch list with pagination. |
| `GET /repos/:owner/:repo/branches/:branch` | semantic | Single branch with commit pointer. |
| `DELETE /repos/:owner/:repo/git/refs/heads/:branch` | semantic | 422 on default branch or branch backing an open PR. |
| `GET /repos/:owner/:repo/contents/*` (READ) | semantic | Existing GET preserved. |
| `PUT /repos/:owner/:repo/contents/*` (CREATE/UPDATE) | semantic | Existing PUT preserved. |
| `DELETE /repos/:owner/:repo/contents/*` | semantic | Requires `sha`; advances branch head with deletion commit. |
| `GET /repos/:owner/:repo/commits/:ref` | semantic | Single commit with stats and file_versions. |
| `GET /repos/:owner/:repo/compare/:basehead` | shape | First-parent ancestry; status=ahead/behind/identical/diverged. |
| `POST /repos/:owner/:repo/statuses/:sha` | semantic | Append-only commit statuses with 404 if SHA not in repo. |
| `GET /repos/:owner/:repo/commits/:ref/status` | semantic | Combined-status rule applied across recorded statuses. |
| `POST /repos/:owner/:repo/check-runs` | semantic | 422 if `status=completed` without `conclusion`. |
| `GET /repos/:owner/:repo/commits/:ref/check-runs` | semantic | Most-recent-started-first; pagination. |
| `GET /repos/:owner/:repo/milestones` | semantic | State filter + pagination. |
| `POST /repos/:owner/:repo/milestones` | semantic | 422 on duplicate title. |
| `PATCH /repos/:owner/:repo/milestones/:number` | semantic | Closes/reopens with `closed_at` bookkeeping. |
| `DELETE /repos/:owner/:repo/milestones/:number` | semantic | 404 on unknown milestone. |
| `GET /repos/:owner/:repo/tags` | semantic | Tag → commit SHA. |
| `GET /repos/:owner/:repo/releases` | semantic | Newest-first; includes drafts. |
| `GET /repos/:owner/:repo/releases/latest` | semantic | Skips drafts and prereleases. |
| `POST /repos/:owner/:repo/releases` | semantic | Auto-creates tag from `target_commitish` if missing. |
| `GET /user` | semantic | Returns JWT-claimed `login`. |
| `GET /search/*` | semantic | Searches clone state for repositories, code, issues, and users. |
| `POST /mcp/call` and `POST /mcp/tools/:name` | semantic | MCP tools mutate the same state as REST routes. |
| Any unsupported path | unsupported | Returns loud `501` with supported surfaces instead of empty `200` or random `500`. |
