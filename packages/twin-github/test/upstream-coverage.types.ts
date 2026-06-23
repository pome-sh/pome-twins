// SPDX-License-Identifier: Apache-2.0
//
// FDRS-476 (phase 2 of FDRS-475) — upstream-added-field coverage guard (type-only; never run).
//
// File name ends in `.types.ts`, NOT `.test.ts`: it matches the tsconfig
// `test/**/*.ts` include (so `bun run typecheck` checks it) but NOT vitest's
// `*.test.ts` glob (so it is never executed as a test). The build tsconfig
// excludes `test/`, so it never ships.
//
// For each anchored serializer, `<Name>_Allow` is the set of upstream fields
// the twin DELIBERATELY does not emit. Each `AssertNoUncovered<...> = true`
// line fails `tsc` — naming the field — the moment GitHub's official type
// (via @octokit/openapi-types) gains a field the serializer neither emits nor
// lists in its `_Allow` union. That forces an explicit cover-or-register
// decision in the @octokit-bump PR. When typecheck is green, every `_Allow`
// union is provably exact: it equals the current real uncovered set.
//
// EDITING ANY `_Allow` UNION IS A CONSCIOUS FIDELITY DECISION — each entry is a
// field the twin is on record as choosing not to emit.
import type { AssertNoUncovered } from "../src/upstream-types.js";
import type {
  AuthenticatedUser,
  CheckRun,
  CombinedStatus,
  Commit,
  CommitComparison,
  CommitWithFiles,
  ContentDirectoryEntry,
  ContentFile,
  DiffEntry,
  Issue,
  IssueComment,
  Label,
  Milestone,
  PullRequest,
  PullRequestReview,
  PullRequestSimple,
  Release,
  Repository,
  ReviewComment,
  ShortBranch,
  SimpleUser,
  Status,
  Tag
} from "../src/upstream-types.js";
import {
  authenticatedUserJson,
  branchJson,
  checkRunJson,
  combinedStatusJson,
  commitJson,
  commitWithFilesJson,
  compareCommitsJson,
  contentDirectoryEntryJson,
  contentFileJson,
  issueCommentJson,
  issueJson,
  labelJson,
  milestoneJson,
  pullRequestFileJson,
  pullRequestJson,
  pullRequestListJson,
  pullRequestReviewCommentJson,
  releaseJson,
  repoJson,
  reviewJson,
  statusJson,
  tagJson,
  userJson
} from "../src/serializers.js";

// Deliberate omissions — editing any union below is a conscious fidelity decision.
type User_Allow =
  | "url" | "email" | "name" | "gravatar_id" | "followers_url" | "following_url"
  | "gists_url" | "starred_url" | "subscriptions_url" | "organizations_url"
  | "repos_url" | "events_url" | "received_events_url" | "starred_at" | "user_view_type";
const _cov_userJson: AssertNoUncovered<SimpleUser, ReturnType<typeof userJson>, User_Allow> = true;

type Repo_Allow =
  | "size" | "events_url" | "starred_at" | "license" | "forks" | "permissions"
  | "archive_url" | "assignees_url" | "blobs_url" | "branches_url"
  | "collaborators_url" | "comments_url" | "commits_url" | "compare_url"
  | "contributors_url" | "deployments_url" | "downloads_url" | "forks_url"
  | "git_commits_url" | "git_refs_url" | "git_tags_url" | "git_url"
  | "issue_comment_url" | "issue_events_url" | "keys_url" | "labels_url"
  | "languages_url" | "merges_url" | "milestones_url" | "notifications_url"
  | "releases_url" | "ssh_url" | "stargazers_url" | "statuses_url"
  | "subscribers_url" | "subscription_url" | "tags_url" | "teams_url"
  | "trees_url" | "clone_url" | "mirror_url" | "hooks_url" | "svn_url"
  | "homepage" | "language" | "forks_count" | "stargazers_count"
  | "watchers_count" | "open_issues_count" | "is_template" | "topics"
  | "has_issues" | "has_projects" | "has_wiki" | "has_pages" | "has_downloads"
  | "has_discussions" | "archived" | "disabled" | "visibility"
  | "allow_rebase_merge" | "temp_clone_token" | "allow_squash_merge"
  | "allow_auto_merge" | "delete_branch_on_merge" | "allow_update_branch"
  | "use_squash_pr_title_as_default" | "squash_merge_commit_title"
  | "squash_merge_commit_message" | "merge_commit_title" | "merge_commit_message"
  | "allow_merge_commit" | "allow_forking" | "web_commit_signoff_required"
  | "open_issues" | "watchers" | "master_branch" | "anonymous_access_enabled"
  | "code_search_index_status";
const _cov_repoJson: AssertNoUncovered<Repository, ReturnType<typeof repoJson>, Repo_Allow> = true;

type Branch_Allow = "protection" | "protection_url";
const _cov_branchJson: AssertNoUncovered<ShortBranch, ReturnType<typeof branchJson>, Branch_Allow> = true;

type Commit_Allow = "files" | "stats";
const _cov_commitJson: AssertNoUncovered<Commit, ReturnType<typeof commitJson>, Commit_Allow> = true;

type ContentFile_Allow = "target" | "submodule_git_url";
const _cov_contentFileJson: AssertNoUncovered<ContentFile, ReturnType<typeof contentFileJson>, ContentFile_Allow> = true;

type ContentDirectoryEntry_Allow = "content" | "_links";
const _cov_contentDirectoryEntryJson: AssertNoUncovered<ContentDirectoryEntry[number], ReturnType<typeof contentDirectoryEntryJson>, ContentDirectoryEntry_Allow> = true;

type Label_Allow = never;
const _cov_labelJson: AssertNoUncovered<Label, ReturnType<typeof labelJson>, Label_Allow> = true;

type Issue_Allow =
  | "type" | "url" | "reactions" | "repository" | "milestone" | "events_url"
  | "state_reason" | "active_lock_reason" | "pull_request" | "draft"
  | "closed_by" | "body_html" | "body_text" | "timeline_url"
  | "performed_via_github_app" | "author_association" | "sub_issues_summary"
  | "parent_issue_url" | "issue_dependencies_summary" | "issue_field_values";
const _cov_issueJson: AssertNoUncovered<Issue, ReturnType<typeof issueJson>, Issue_Allow> = true;

type IssueComment_Allow =
  | "url" | "reactions" | "body_html" | "body_text"
  | "performed_via_github_app" | "author_association";
const _cov_issueCommentJson: AssertNoUncovered<IssueComment, ReturnType<typeof issueCommentJson>, IssueComment_Allow> = true;

type PullRequest_Allow =
  | "labels" | "assignee" | "assignees" | "milestone" | "_links"
  | "active_lock_reason" | "comments" | "author_association" | "diff_url"
  | "patch_url" | "requested_reviewers" | "requested_teams" | "auto_merge"
  | "mergeable" | "rebaseable" | "mergeable_state" | "merged_by"
  | "review_comments" | "maintainer_can_modify";
const _cov_pullRequestJson: AssertNoUncovered<PullRequest, ReturnType<typeof pullRequestJson>, PullRequest_Allow> = true;

type PullRequestList_Allow =
  | "labels" | "assignee" | "assignees" | "milestone" | "merged" | "_links"
  | "active_lock_reason" | "comments" | "author_association" | "diff_url"
  | "patch_url" | "requested_reviewers" | "requested_teams" | "auto_merge"
  | "mergeable" | "rebaseable" | "mergeable_state" | "merged_by"
  | "review_comments" | "maintainer_can_modify" | "commits" | "additions"
  | "deletions" | "changed_files";
const _cov_pullRequestListJson: AssertNoUncovered<PullRequestSimple, ReturnType<typeof pullRequestListJson>, PullRequestList_Allow> = true;

type PullRequestFile_Allow = "previous_filename";
const _cov_pullRequestFileJson: AssertNoUncovered<DiffEntry, ReturnType<typeof pullRequestFileJson>, PullRequestFile_Allow> = true;

type Review_Allow = "_links" | "body_html" | "body_text" | "author_association";
const _cov_reviewJson: AssertNoUncovered<PullRequestReview, ReturnType<typeof reviewJson>, Review_Allow> = true;

type Status_Allow = "avatar_url" | "creator";
const _cov_statusJson: AssertNoUncovered<Status, ReturnType<typeof statusJson>, Status_Allow> = true;

type CombinedStatus_Allow = never;
const _cov_combinedStatusJson: AssertNoUncovered<CombinedStatus, ReturnType<typeof combinedStatusJson>, CombinedStatus_Allow> = true;

type Milestone_Allow = never;
const _cov_milestoneJson: AssertNoUncovered<Milestone, ReturnType<typeof milestoneJson>, Milestone_Allow> = true;

type Tag_Allow = never;
const _cov_tagJson: AssertNoUncovered<Tag, ReturnType<typeof tagJson>, Tag_Allow> = true;

type Release_Allow =
  | "updated_at" | "reactions" | "body_html" | "body_text" | "immutable"
  | "mentions_count" | "discussion_url";
const _cov_releaseJson: AssertNoUncovered<Release, ReturnType<typeof releaseJson>, Release_Allow> = true;

type CheckRun_Allow = "deployment";
const _cov_checkRunJson: AssertNoUncovered<CheckRun, ReturnType<typeof checkRunJson>, CheckRun_Allow> = true;

type PullRequestReviewComment_Allow =
  | "reactions" | "_links" | "body_html" | "body_text" | "author_association"
  | "subject_type";
const _cov_pullRequestReviewCommentJson: AssertNoUncovered<ReviewComment, ReturnType<typeof pullRequestReviewCommentJson>, PullRequestReviewComment_Allow> = true;

type CommitWithFiles_Allow = never;
const _cov_commitWithFilesJson: AssertNoUncovered<CommitWithFiles, ReturnType<typeof commitWithFilesJson>, CommitWithFiles_Allow> = true;

type CompareCommits_Allow = never;
const _cov_compareCommitsJson: AssertNoUncovered<CommitComparison, ReturnType<typeof compareCommitsJson>, CompareCommits_Allow> = true;

type AuthenticatedUser_Allow =
  | "url" | "collaborators" | "gravatar_id" | "followers_url" | "following_url"
  | "gists_url" | "starred_url" | "subscriptions_url" | "organizations_url"
  | "repos_url" | "events_url" | "received_events_url" | "user_view_type"
  | "notification_email" | "hireable" | "twitter_username" | "private_gists"
  | "total_private_repos" | "owned_private_repos" | "disk_usage"
  | "two_factor_authentication" | "plan" | "business_plus" | "ldap_dn";
const _cov_authenticatedUserJson: AssertNoUncovered<AuthenticatedUser, ReturnType<typeof authenticatedUserJson>, AuthenticatedUser_Allow> = true;

// Reference the consts so noUnusedLocals (if enabled) stays quiet; zero runtime cost.
void [
  _cov_userJson, _cov_repoJson, _cov_branchJson, _cov_commitJson, _cov_contentFileJson,
  _cov_contentDirectoryEntryJson, _cov_labelJson, _cov_issueJson, _cov_issueCommentJson,
  _cov_pullRequestJson, _cov_pullRequestListJson, _cov_pullRequestFileJson, _cov_reviewJson,
  _cov_statusJson, _cov_combinedStatusJson, _cov_milestoneJson, _cov_tagJson, _cov_releaseJson,
  _cov_checkRunJson, _cov_pullRequestReviewCommentJson, _cov_commitWithFilesJson,
  _cov_compareCommitsJson, _cov_authenticatedUserJson
];
