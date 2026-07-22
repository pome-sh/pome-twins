// SPDX-License-Identifier: Apache-2.0
//
// emoji.list (Wave 3 / SL4). Custom emoji map for the workspace — name → URL
// or `alias:<name>` pseudo-protocol, matching real Slack's envelope.

import type { EmojiRow, SlackTwinDatabase } from "../types.js";
import { SLACK_TWIN_HOST } from "../serializers.js";

export type EmojiHost = {
  db: SlackTwinDatabase;
  workspaceId: string;
};

export function emojiList(host: EmojiHost): Record<string, unknown> {
  const rows = host.db
    .prepare(`SELECT name, value FROM emoji WHERE team_id = ? ORDER BY name`)
    .all(host.workspaceId) as Array<Pick<EmojiRow, "name" | "value">>;
  const emoji: Record<string, string> = {};
  for (const row of rows) {
    emoji[row.name] = row.value;
  }
  return { emoji };
}

/** Deterministic URL for a seeded custom emoji image. */
export function emojiImageUrl(name: string): string {
  return `${SLACK_TWIN_HOST}/emoji/${encodeURIComponent(name)}/1.png`;
}

export function seedEmojiRows(
  db: SlackTwinDatabase,
  teamId: string,
  entries: Array<{ name: string; url?: string; alias?: string }>
): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO emoji (team_id, name, value) VALUES (?, ?, ?)`
  );
  for (const entry of entries) {
    const value =
      entry.alias !== undefined && entry.alias.length > 0
        ? `alias:${entry.alias}`
        : entry.url && entry.url.length > 0
          ? entry.url
          : emojiImageUrl(entry.name);
    insert.run(teamId, entry.name, value);
  }
}
