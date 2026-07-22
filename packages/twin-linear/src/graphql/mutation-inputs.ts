// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { badUserInput } from "../errors.js";
import type { IssueCreateInput, IssueUpdateInput } from "../domain/index.js";

const optionalString = z.string().nullish();
const optionalStringArray = z.array(z.string()).nullish();

export const issueCreateInputSchema = z
  .object({
    teamId: z.string().min(1),
    title: z.string().min(1),
    description: optionalString,
    priority: z.number().nullish(),
    estimate: z.number().nullish(),
    stateId: optionalString,
    assigneeId: optionalString,
    delegateId: optionalString,
    labelIds: optionalStringArray,
    projectId: optionalString,
    cycleId: optionalString,
    parentId: optionalString,
    createAsUser: optionalString,
    displayIconUrl: optionalString,
    dueDate: optionalString,
  })
  .strict();

export const issueUpdateInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    description: optionalString,
    priority: z.number().nullish(),
    estimate: z.number().nullish(),
    stateId: optionalString,
    assigneeId: optionalString,
    delegateId: optionalString,
    labelIds: optionalStringArray,
    projectId: optionalString,
    cycleId: optionalString,
    parentId: optionalString,
    archivedAt: optionalString,
    dueDate: optionalString,
  })
  .strict();

export const commentCreateInputSchema = z
  .object({
    issueId: z.string().min(1).optional(),
    parentId: optionalString,
    body: z.string().min(1),
    createAsUser: optionalString,
    displayIconUrl: optionalString,
  })
  .strict();

export const commentUpdateInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    body: z.string().min(1),
  })
  .strict();

export const issueLabelCreateInputSchema = z
  .object({
    name: z.string().min(1),
    color: z.string().optional(),
    description: optionalString,
    teamId: optionalString,
  })
  .strict();

export const issueLabelUpdateInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    color: z.string().optional(),
    description: optionalString,
  })
  .strict();

export const webhookCreateInputSchema = z
  .object({
    url: z.string().min(1),
    label: z.string().optional(),
    resourceTypes: z.array(z.string()).optional(),
    teamId: optionalString,
    allPublicTeams: z.boolean().optional(),
    secret: optionalString,
    enabled: z.boolean().optional(),
  })
  .strict();

export const agentSessionOnIssueInputSchema = z
  .object({
    issueId: z.string().min(1),
    agentUserId: z.string().optional(),
    plan: optionalString,
    externalUrl: optionalString,
  })
  .strict();

export const agentSessionOnCommentInputSchema = z
  .object({
    commentId: z.string().min(1),
    agentUserId: z.string().optional(),
    plan: optionalString,
    externalUrl: optionalString,
  })
  .strict();

export const agentSessionUpdateInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    state: z.string().optional(),
    plan: optionalString,
    externalUrl: optionalString,
  })
  .strict();

export const agentActivityCreateInputSchema = z
  .object({
    sessionId: z.string().min(1),
    type: z.string().min(1),
    body: z.string().min(1),
    ephemeral: z.boolean().optional(),
  })
  .strict();

function parseOrBadUserInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    badUserInput(issue ? `${label}: ${issue.message}` : `Invalid ${label}`);
  }
  return parsed.data;
}

export function parseIssueCreateInput(input: unknown): IssueCreateInput {
  const raw = parseOrBadUserInput(issueCreateInputSchema, input, "issueCreate input");
  return {
    teamId: raw.teamId,
    title: raw.title,
    description: raw.description ?? null,
    priority: raw.priority ?? undefined,
    estimate: "estimate" in raw ? (raw.estimate ?? null) : undefined,
    stateId: raw.stateId ?? null,
    assigneeId: raw.assigneeId ?? null,
    delegateId: raw.delegateId ?? null,
    labelIds: raw.labelIds ?? null,
    projectId: raw.projectId ?? null,
    cycleId: raw.cycleId ?? null,
    parentId: raw.parentId ?? null,
    createAsUser: raw.createAsUser ?? null,
    displayIconUrl: raw.displayIconUrl ?? null,
    dueDate: raw.dueDate ?? null,
  };
}

export function parseIssueUpdateInput(input: unknown): { id?: string; patch: IssueUpdateInput } {
  const raw = parseOrBadUserInput(issueUpdateInputSchema, input, "issueUpdate input");
  const patch: IssueUpdateInput = {};
  if ("title" in raw && raw.title !== undefined) patch.title = raw.title;
  if ("description" in raw) patch.description = raw.description ?? null;
  if ("priority" in raw) patch.priority = raw.priority ?? null;
  if ("estimate" in raw) patch.estimate = raw.estimate ?? null;
  if ("stateId" in raw) patch.stateId = raw.stateId ?? null;
  if ("assigneeId" in raw) patch.assigneeId = raw.assigneeId ?? null;
  if ("delegateId" in raw) patch.delegateId = raw.delegateId ?? null;
  if ("labelIds" in raw) patch.labelIds = raw.labelIds ?? [];
  if ("projectId" in raw) patch.projectId = raw.projectId ?? null;
  if ("cycleId" in raw) patch.cycleId = raw.cycleId ?? null;
  if ("parentId" in raw) patch.parentId = raw.parentId ?? null;
  if ("archivedAt" in raw) patch.archivedAt = raw.archivedAt ?? null;
  if ("dueDate" in raw) patch.dueDate = raw.dueDate ?? null;
  return { id: raw.id, patch };
}

export function parseCommentCreateInput(input: unknown) {
  const raw = parseOrBadUserInput(commentCreateInputSchema, input, "commentCreate input");
  return {
    issueId: raw.issueId,
    parentId: raw.parentId ?? null,
    body: raw.body,
    createAsUser: raw.createAsUser ?? null,
    displayIconUrl: raw.displayIconUrl ?? null,
  };
}

export function parseCommentUpdateInput(input: unknown) {
  return parseOrBadUserInput(commentUpdateInputSchema, input, "commentUpdate input");
}

export function parseIssueLabelCreateInput(input: unknown) {
  const raw = parseOrBadUserInput(issueLabelCreateInputSchema, input, "issueLabelCreate input");
  return {
    name: raw.name,
    color: raw.color,
    description: raw.description ?? null,
    teamId: raw.teamId ?? null,
  };
}

export function parseIssueLabelUpdateInput(input: unknown) {
  const raw = parseOrBadUserInput(issueLabelUpdateInputSchema, input, "issueLabelUpdate input");
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color,
    description: "description" in raw ? (raw.description ?? null) : undefined,
  };
}

export function parseWebhookCreateInput(input: unknown) {
  const raw = parseOrBadUserInput(webhookCreateInputSchema, input, "webhookCreate input");
  return {
    url: raw.url,
    label: raw.label,
    resourceTypes: raw.resourceTypes,
    teamId: raw.teamId ?? null,
    allPublicTeams: raw.allPublicTeams,
    secret: raw.secret ?? null,
    enabled: raw.enabled,
  };
}

export function parseAgentSessionOnIssueInput(input: unknown) {
  const raw = parseOrBadUserInput(agentSessionOnIssueInputSchema, input, "agentSessionCreateOnIssue input");
  return {
    issueId: raw.issueId,
    agentUserId: raw.agentUserId,
    plan: raw.plan ?? null,
    externalUrl: raw.externalUrl ?? null,
  };
}

export function parseAgentSessionOnCommentInput(input: unknown) {
  const raw = parseOrBadUserInput(
    agentSessionOnCommentInputSchema,
    input,
    "agentSessionCreateOnComment input"
  );
  return {
    commentId: raw.commentId,
    agentUserId: raw.agentUserId,
    plan: raw.plan ?? null,
    externalUrl: raw.externalUrl ?? null,
  };
}

export function parseAgentSessionUpdateInput(input: unknown) {
  const raw = parseOrBadUserInput(agentSessionUpdateInputSchema, input, "agentSessionUpdate input");
  return {
    id: raw.id,
    state: raw.state,
    plan: "plan" in raw ? (raw.plan ?? null) : undefined,
    externalUrl: "externalUrl" in raw ? (raw.externalUrl ?? null) : undefined,
  };
}

export function parseAgentActivityCreateInput(input: unknown) {
  const raw = parseOrBadUserInput(agentActivityCreateInputSchema, input, "agentActivityCreate input");
  return {
    sessionId: raw.sessionId,
    type: raw.type,
    body: raw.body,
    ephemeral: raw.ephemeral,
  };
}
