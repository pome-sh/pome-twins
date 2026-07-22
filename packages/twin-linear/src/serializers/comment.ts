// SPDX-License-Identifier: Apache-2.0
import type { LinearComment } from "../types.js";

export function commentCore(comment: LinearComment) {
  return {
    id: comment.id,
    body: comment.body,
    issueId: comment.issueId,
    parentId: comment.parentId,
    userId: comment.userId,
    createAsUser: comment.createAsUser,
    displayIconUrl: comment.displayIconUrl,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

export function serializeCommentWebhook(comment: LinearComment): Record<string, unknown> {
  const core = commentCore(comment);
  return {
    id: core.id,
    body: core.body,
    issueId: core.issueId,
    userId: core.userId,
    createdAt: core.createdAt,
    updatedAt: core.updatedAt,
  };
}

export function serializeCommentMcp(comment: LinearComment) {
  const core = commentCore(comment);
  return {
    id: core.id,
    body: core.body,
    issueId: core.issueId,
    parentId: core.parentId,
    userId: core.userId,
    createdAt: core.createdAt,
  };
}

export function commentGraphqlScalars(comment: LinearComment) {
  const core = commentCore(comment);
  return {
    id: core.id,
    body: core.body,
    createdAt: core.createdAt,
    updatedAt: core.updatedAt,
    createAsUser: core.createAsUser,
    displayIconUrl: core.displayIconUrl,
  };
}
