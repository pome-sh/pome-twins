// SPDX-License-Identifier: Apache-2.0
import type { LinearComment, LinearIssue } from "../types.js";
import { serializeCommentWebhook, serializeIssueWebhook } from "../serializers/index.js";
import {
  dispatchLinearWebhook,
  type LinearWebhookEvent,
  type LinearWebhookHost,
} from "../webhooks/dispatch.js";

export async function emitWebhook(
  domain: LinearWebhookHost,
  event: LinearWebhookEvent
): Promise<void> {
  await dispatchLinearWebhook(domain, event);
}

export function issueWebhookPayload(issue: LinearIssue): Record<string, unknown> {
  return serializeIssueWebhook(issue);
}

export function commentWebhookPayload(comment: LinearComment): Record<string, unknown> {
  return serializeCommentWebhook(comment);
}
