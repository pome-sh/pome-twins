// SPDX-License-Identifier: Apache-2.0
type RepoRow = {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  created_at: string;
  updated_at: string;
};

type LabelRow = {
  name: string;
  color: string;
  description: string;
};

type IssueRow = {
  repo_id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  assignee_login: string | null;
  created_at: string;
  updated_at: string;
};

type CommentRow = {
  id: number;
  body: string;
  user_login: string;
  created_at: string;
};

export function repoJson(repo: RepoRow) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: {
      login: repo.owner,
      type: "Organization"
    },
    private: false,
    description: repo.description,
    html_url: `https://github.com/${repo.full_name}`,
    issues_url: `https://api.github.com/repos/${repo.full_name}/issues{/number}`,
    labels_url: `https://api.github.com/repos/${repo.full_name}/labels{/name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at
  };
}

export function labelJson(label: LabelRow) {
  return {
    id: stableNumericId(label.name),
    node_id: `LA_${label.name}`,
    url: `https://api.github.com/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description
  };
}

export function collaboratorJson(login: string) {
  return {
    login,
    id: stableNumericId(login),
    type: "User",
    site_admin: false
  };
}

export function issueJson(issue: IssueRow, labels: LabelRow[], repo: RepoRow) {
  return {
    id: stableNumericId(`${repo.full_name}#${issue.number}`),
    node_id: `I_${repo.full_name}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: labels.map(labelJson),
    assignee: issue.assignee_login ? collaboratorJson(issue.assignee_login) : null,
    assignees: issue.assignee_login ? [collaboratorJson(issue.assignee_login)] : [],
    comments: 0,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.full_name}`,
    labels_url: `https://api.github.com/repos/${repo.full_name}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.github.com/repos/${repo.full_name}/issues/${issue.number}/comments`,
    created_at: issue.created_at,
    updated_at: issue.updated_at
  };
}

export function commentJson(comment: CommentRow, repo: RepoRow, issueNumber: number) {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: collaboratorJson(comment.user_login),
    html_url: `https://github.com/${repo.full_name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `https://api.github.com/repos/${repo.full_name}/issues/${issueNumber}`,
    created_at: comment.created_at,
    updated_at: comment.created_at
  };
}

function stableNumericId(input: string) {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}
