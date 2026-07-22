// SPDX-License-Identifier: Apache-2.0
export type { SearchDocument, SearchNode } from "./search-parse.js";
export {
  CATEGORY_LABELS,
  KNOWN_FIELDS,
  SEARCH_MAILBOX_MESSAGE_BUDGET,
  assertHasOperator,
  assertSearchTerm,
  parseDate,
  parseDuration,
  parseSearchQuery,
  parseSize,
  validateSearchQuery,
} from "./search-parse.js";
export { matchesSearch, stripHtmlTags } from "./search-match.js";
