// SPDX-License-Identifier: Apache-2.0
import type { LinearDocument } from "../types.js";

export function serializeDocumentMcp(doc: LinearDocument) {
  return {
    id: doc.id,
    title: doc.title,
    content: doc.content,
    slug: doc.slug,
    projectId: doc.projectId,
    teamId: doc.teamId,
    issueId: doc.issueId,
    cycleId: doc.cycleId,
    icon: doc.icon,
    color: doc.color,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
