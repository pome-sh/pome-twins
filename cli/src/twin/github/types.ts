// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";

export type GitHubTwinDatabase = Database.Database;

export type SeedUser = {
  login: string;
  type?: "User" | "Organization";
  name?: string;
};

export type SeedFile = {
  path: string;
  content: string;
  branch?: string;
};

export type SeedPullRequest = {
  number?: number;
  title: string;
  body?: string;
  head: string;
  base?: string;
  state?: "open" | "closed";
  author?: string;
};

export type SeedRepository = {
  owner: string;
  name: string;
  description?: string;
  default_branch?: string;
  labels?: Array<{ name: string; color?: string; description?: string }>;
  collaborators?: string[];
  files?: SeedFile[];
  issues?: Array<{
    number: number;
    title: string;
    body?: string;
    state?: "open" | "closed";
    labels?: string[];
    assignee?: string | null;
  }>;
  pull_requests?: SeedPullRequest[];
};

export type SeedState = {
  users?: SeedUser[];
  repositories: SeedRepository[];
};

export type RecorderEvent = {
  ts: string;
  run_id: string;
  twin: "github";
  request_id: string;
  method: string;
  path: string;
  request_body: unknown;
  status: number;
  response_body: unknown;
  latency_ms: number;
  fidelity: "semantic" | "unsupported";
  state_mutation: boolean;
  error: string | null;
};

export type Recorder = {
  record(event: RecorderEvent): void;
  events(): RecorderEvent[];
};
