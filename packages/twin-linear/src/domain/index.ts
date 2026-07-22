// SPDX-License-Identifier: Apache-2.0
//
// Domain barrel (F-679): re-exports only.
export { LinearDomain } from "./linear-domain.js";
export type { ActorContext, PendingCode } from "./linear-domain.js";
export type { IssueCreateInput, IssueUpdateInput, IssueListFilter } from "./issues.js";
export { emitWebhook, issueWebhookPayload, commentWebhookPayload } from "./webhooks.js";
