// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { MCP_PAGE_MAX } from "./types.js";

export const limitSchema = z.number().int().positive().max(MCP_PAGE_MAX).optional();

export const listIssuesSchema = z
  .object({
    team: z.string().optional(),
    assignee: z.string().optional(),
    state: z.string().optional(),
    limit: limitSchema,
    cursor: z.string().optional(),
    query: z.string().optional(),
  })
  .strict();

export const getIssueSchema = z.object({ id: z.string().min(1) }).strict();

export const saveIssueSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    team: z.string().min(1).optional(),
    description: z.string().optional(),
    assignee: z.string().optional(),
    state: z.string().optional(),
    priority: z.number().optional(),
    estimate: z.number().nullable().optional(),
    labels: z.array(z.string()).optional(),
    project: z.string().optional(),
    cycle: z.string().optional(),
    parentId: z.string().nullable().optional(),
    blocks: z.array(z.string()).optional(),
    blockedBy: z.array(z.string()).optional(),
    relatedTo: z.array(z.string()).optional(),
  })
  .strict();

export const listCommentsSchema = z
  .object({
    issueId: z.string().min(1),
    limit: limitSchema,
    cursor: z.string().optional(),
  })
  .strict();

export const saveCommentSchema = z
  .object({
    id: z.string().min(1).optional(),
    issueId: z.string().min(1).optional(),
    parentId: z.string().min(1).optional(),
    body: z.string().min(1),
  })
  .strict();

export const deleteCommentSchema = z.object({ id: z.string().min(1) }).strict();

export const listTeamsSchema = z.object({ limit: limitSchema, cursor: z.string().optional() }).strict();
export const getTeamSchema = z.object({ query: z.string().min(1) }).strict();
export const listUsersSchema = z.object({ limit: limitSchema, cursor: z.string().optional() }).strict();
export const getUserSchema = z.object({ query: z.string().min(1) }).strict();
export const listIssueStatusesSchema = z.object({ team: z.string().min(1) }).strict();

export const getIssueStatusSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    team: z.string().optional(),
  })
  .strict();

export const listIssueLabelsSchema = z
  .object({
    team: z.string().optional(),
    limit: limitSchema,
    cursor: z.string().optional(),
  })
  .strict();

export const createIssueLabelSchema = z
  .object({
    name: z.string().min(1),
    color: z.string().optional(),
    description: z.string().optional(),
    team: z.string().optional(),
  })
  .strict();

export const listProjectsSchema = z
  .object({
    team: z.string().optional(),
    limit: limitSchema,
    cursor: z.string().optional(),
  })
  .strict();

export const getProjectSchema = z.object({ query: z.string().min(1) }).strict();

export const saveProjectSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    team: z.string().optional(),
    description: z.string().optional(),
    state: z.string().optional(),
  })
  .strict();

export const listCyclesSchema = z
  .object({
    teamId: z.string().min(1),
    limit: limitSchema,
    cursor: z.string().optional(),
  })
  .strict();

export const searchDocumentationSchema = z.object({ query: z.string().min(1) }).strict();

export const listDocumentsSchema = z
  .object({
    projectId: z.string().optional(),
    teamId: z.string().optional(),
    query: z.string().optional(),
    limit: limitSchema,
    cursor: z.string().optional(),
  })
  .strict();

export const getDocumentSchema = z.object({ id: z.string().min(1) }).strict();

export const saveDocumentSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    content: z.string().optional(),
    project: z.string().optional(),
    team: z.string().optional(),
    issue: z.string().optional(),
    cycle: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
  })
  .strict();
