// SPDX-License-Identifier: Apache-2.0
import type { TwinDatabase } from "@pome-sh/sdk";

export type { RecorderEvent } from "@pome-sh/shared-types";

// The engine's driver wrapper is the only database surface a twin sees
// (F-681/F-682): prepare/exec/pragma/transaction/close.
export type GitHubCloneDatabase = TwinDatabase;

export type GitHubStateSeed = {
  users?: SeedUser[];
  repositories: SeedRepository[];
};

export type SeedUser = {
  login: string;
  type?: "User" | "Organization";
  name?: string;
};

export type SeedRepository = {
  owner: string;
  name: string;
  description?: string;
  private?: boolean;
  default_branch?: string;
  collaborators?: string[];
  labels?: Array<{ name: string; color?: string; description?: string }>;
  files?: Array<{ path: string; content: string; branch?: string }>;
  issues?: Array<{
    number?: number;
    title: string;
    body?: string;
    state?: "open" | "closed";
    labels?: string[];
    assignees?: string[];
  }>;
  pull_requests?: Array<{
    number?: number;
    title: string;
    body?: string;
    head: string;
    base?: string;
    state?: "open" | "closed";
    author?: string;
    reviews?: Array<{
      author: string;
      state?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
      body?: string;
    }>;
    statuses?: Array<{
      context?: string;
      state?: "error" | "failure" | "pending" | "success";
      description?: string;
    }>;
  }>;
};

export type RepoRow = {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: 0 | 1;
  default_branch: string;
  fork: 0 | 1;
  parent_full_name: string | null;
  entity_counter: number;
  created_at: string;
  updated_at: string;
};

export type BranchRow = {
  id: number;
  repo_id: number;
  name: string;
  head_sha: string | null;
  created_at: string;
  updated_at: string;
};

export type CommitRow = {
  sha: string;
  repo_id: number;
  message: string;
  author_login: string;
  committer_login: string;
  parent_sha: string | null;
  tree_sha: string;
  created_at: string;
};

export type FileRow = {
  repo_id: number;
  branch: string;
  path: string;
  content: string;
  sha: string;
  size: number;
  updated_at: string;
};

export type LabelRow = {
  repo_id: number;
  name: string;
  color: string;
  description: string;
};

export type IssueRow = {
  repo_id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user_login: string;
  assignee_login: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type IssueCommentRow = {
  id: number;
  repo_id: number;
  issue_number: number;
  body: string;
  user_login: string;
  created_at: string;
  updated_at: string;
};

export type PullRequestRow = {
  repo_id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user_login: string;
  head_repo_id: number;
  head_ref: string;
  head_sha: string | null;
  base_repo_id: number;
  base_ref: string;
  base_sha: string | null;
  merged: 0 | 1;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
};

export type PullRequestReviewRow = {
  id: number;
  repo_id: number;
  pull_number: number;
  user_login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  body: string;
  commit_sha: string | null;
  submitted_at: string;
};

export type PullRequestFileRow = {
  repo_id: number;
  pull_number: number;
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch: string;
};

export type CommitStatusRow = {
  id: number;
  repo_id: number;
  sha: string;
  state: "error" | "failure" | "pending" | "success";
  context: string;
  description: string;
  target_url: string;
  created_at: string;
  updated_at: string;
};

export type MilestoneRow = {
  repo_id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  description: string;
  due_on: string | null;
  creator_login: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type TagRow = {
  repo_id: number;
  name: string;
  commit_sha: string;
  created_at: string;
};

export type ReleaseRow = {
  id: number;
  repo_id: number;
  tag_name: string;
  target_commitish: string;
  name: string | null;
  body: string;
  draft: 0 | 1;
  prerelease: 0 | 1;
  author_login: string;
  created_at: string;
  published_at: string | null;
};

export type CheckRunRow = {
  id: number;
  repo_id: number;
  head_sha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped" | "stale" | null;
  details_url: string;
  external_id: string;
  output_title: string | null;
  output_summary: string | null;
  started_at: string;
  completed_at: string | null;
};

export type PullRequestReviewCommentRow = {
  id: number;
  repo_id: number;
  pull_number: number;
  path: string;
  body: string;
  user_login: string;
  created_at: string;
  updated_at: string;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  commit_sha: string | null;
  in_reply_to_id: number | null;
};

export type CollaboratorRow = {
  repo_id: number;
  login: string;
  permission: string;
  invitation_state: "pending" | "accepted";
};
