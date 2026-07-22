// SPDX-License-Identifier: Apache-2.0
export { GmailDomain } from "./domain/index.js";
export type { DraftResource, FilterResource, LabelResource } from "./domain/index.js";
export { openGmailTwinDatabase, migrate, resetDatabase } from "./db.js";
export { GmailError, gmailErrorEnvelope } from "./errors.js";
export { DEFAULT_GMAIL_EMAIL, identityFromSession, resolveUserEmail } from "./identity.js";
export {
  canonicalRaw,
  composeMime,
  decodeGmailRaw,
  encodeGmailRaw,
  mimeSha256,
  normalizeSubject,
  parseMime,
  stripBcc,
} from "./mime.js";
export { gmailTools } from "./mcp.js";
export { projectGmailRecording } from "./recording.js";
export {
  matchesSearch,
  parseSearchQuery,
  SEARCH_MAILBOX_MESSAGE_BUDGET,
  stripHtmlTags,
  validateSearchQuery,
} from "./search.js";
export {
  agentPathInboxMailbox,
  DEFAULT_GMAIL_AGENT_EMAIL,
  defaultSeedState,
  gmailSeedSchema,
  loadSeedFromEnv,
  parseSeed,
} from "./seed.js";
export {
  capExportRows,
  exportGmailState,
  gmailStateDelta,
  STATE_EXPORT_COLLECTION_CAP,
  STATE_EXPORT_FULL_MESSAGE_BUDGET,
} from "./state.js";
export { createGmailTwinApp, gmailTwinDefinition, registerGmailRoutes } from "./twin.js";
export type {
  DeliveryMode,
  GmailIdentity,
  GmailStateSeed,
  GmailTwinDatabase,
  HistoryEvent,
  SeedAttachment,
  SeedDraft,
  SeedFilter,
  SeedLabel,
  SeedMailbox,
  SeedMessage,
  SeedSendAs,
  SemanticMessage,
} from "./types.js";
