// SPDX-License-Identifier: Apache-2.0
import { CATEGORY_LABELS, parseDate, parseSize, type SearchNode } from "../search-parse.js";

export type SqlSearchPlan = {
  /** SQL fragment after `WHERE mailbox_id = ?` (leading AND clauses). */
  clauses: string[];
  params: unknown[];
  /**
   * When true, SQL constraints are semantically exact for the AST (label/is/in/size/date).
   * Text/LIKE terms set this false so JS match still runs on candidates.
   */
  exact: boolean;
};

/**
 * Private SQL prefilter for conjunctive search ASTs.
 * Returns null when the query needs a full in-memory scan (OR/NOT/AROUND/free-text).
 */
export function compileSearchToSql(
  ast: SearchNode,
  options: { includeTrash?: boolean; explicitAnywhere?: boolean } = {}
): SqlSearchPlan | null {
  const terms = flattenAndTerms(ast);
  if (terms === null) return null;

  const clauses: string[] = [];
  const params: unknown[] = [];
  let exact = true;
  let folderConstrained = false;

  for (const term of terms) {
    if (term.type === "around") return null;
    if (term.type !== "term") return null;
    const field = term.field;
    const value = term.value;
    if (!field) return null;

    if (field === "is") {
      const status = value.toLocaleLowerCase("en-US");
      if (status === "unread") {
        pushHasLabel(clauses, params, "UNREAD");
      } else if (status === "read") {
        pushNotHasLabel(clauses, params, "UNREAD");
      } else if (status === "starred") {
        pushHasLabel(clauses, params, "STARRED");
      } else if (status === "important") {
        pushHasLabel(clauses, params, "IMPORTANT");
      } else if (status === "muted") {
        pushHasLabel(clauses, params, "MUTED");
      } else {
        pushHasLabel(clauses, params, value.toUpperCase());
        exact = false;
      }
      continue;
    }

    if (field === "in") {
      const folder = value.toLocaleLowerCase("en-US");
      if (folder === "anywhere") {
        folderConstrained = true;
        continue;
      }
      if (folder === "archive") {
        pushNotHasLabel(clauses, params, "INBOX");
        folderConstrained = true;
        continue;
      }
      if (folder === "draft") {
        pushHasLabel(clauses, params, "DRAFT");
        folderConstrained = true;
        continue;
      }
      if (["inbox", "trash", "spam", "sent"].includes(folder)) {
        pushHasLabel(clauses, params, folder.toUpperCase());
        folderConstrained = true;
        continue;
      }
      return null;
    }

    if (field === "label") {
      clauses.push(
        `EXISTS (
          SELECT 1 FROM message_labels ml
          JOIN labels l ON l.mailbox_id = ml.mailbox_id AND l.id = ml.label_id
          WHERE ml.mailbox_id = messages.mailbox_id AND ml.message_id = messages.id
            AND (l.id = ? COLLATE NOCASE OR l.name = ? COLLATE NOCASE)
        )`
      );
      params.push(value, value);
      continue;
    }

    if (field === "category") {
      const mapped = CATEGORY_LABELS[value.toLocaleLowerCase("en-US")];
      if (!mapped) return null;
      pushHasLabel(clauses, params, mapped);
      continue;
    }

    if (field === "from") {
      clauses.push("LOWER(from_address) LIKE ?");
      params.push(`%${value.toLocaleLowerCase("en-US")}%`);
      exact = false;
      continue;
    }

    if (field === "to") {
      clauses.push("LOWER(to_json) LIKE ?");
      params.push(`%${value.toLocaleLowerCase("en-US")}%`);
      exact = false;
      continue;
    }

    if (field === "subject") {
      clauses.push("LOWER(subject) LIKE ?");
      params.push(`%${value.toLocaleLowerCase("en-US")}%`);
      exact = false;
      continue;
    }

    if (field === "after" || field === "newer") {
      clauses.push("internal_date > ?");
      params.push(parseDate(value));
      continue;
    }

    if (field === "before" || field === "older") {
      clauses.push("internal_date < ?");
      params.push(parseDate(value));
      continue;
    }

    if (field === "larger") {
      clauses.push("size_estimate > ?");
      params.push(parseSize(value));
      continue;
    }

    if (field === "smaller") {
      clauses.push("size_estimate < ?");
      params.push(parseSize(value));
      continue;
    }

    if (field === "size") {
      clauses.push("size_estimate = ?");
      params.push(parseSize(value));
      continue;
    }

    if (field === "has") {
      const has = value.toLocaleLowerCase("en-US");
      if (has === "attachment") {
        clauses.push(
          `EXISTS (
            SELECT 1 FROM attachments a
            WHERE a.mailbox_id = messages.mailbox_id AND a.message_id = messages.id
          )`
        );
        continue;
      }
      return null;
    }

    return null;
  }

  if (!options.includeTrash && !options.explicitAnywhere && !folderConstrained) {
    for (const label of ["TRASH", "SPAM", "DRAFT"]) {
      pushNotHasLabel(clauses, params, label);
    }
  }

  return { clauses, params, exact };
}

function flattenAndTerms(node: SearchNode): SearchNode[] | null {
  if (node.type === "and") {
    const out: SearchNode[] = [];
    for (const child of node.children) {
      const nested = flattenAndTerms(child);
      if (nested === null) return null;
      out.push(...nested);
    }
    return out;
  }
  if (node.type === "term" || node.type === "around") return [node];
  return null;
}

function pushHasLabel(clauses: string[], params: unknown[], labelId: string): void {
  clauses.push(
    `EXISTS (
      SELECT 1 FROM message_labels ml
      WHERE ml.mailbox_id = messages.mailbox_id AND ml.message_id = messages.id AND ml.label_id = ?
    )`
  );
  params.push(labelId);
}

function pushNotHasLabel(clauses: string[], params: unknown[], labelId: string): void {
  clauses.push(
    `NOT EXISTS (
      SELECT 1 FROM message_labels ml
      WHERE ml.mailbox_id = messages.mailbox_id AND ml.message_id = messages.id AND ml.label_id = ?
    )`
  );
  params.push(labelId);
}
