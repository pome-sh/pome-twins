// SPDX-License-Identifier: Apache-2.0
import type { SessionValue } from "@pome-sh/sdk/server";
import { notFound } from "./errors.js";
import type { GmailIdentity, GmailTwinDatabase } from "./types.js";

export const DEFAULT_GMAIL_EMAIL = "pome-agent@pome-twin.test";

export function identityFromSession(session?: SessionValue): GmailIdentity {
  const claim = session?.gmail_email;
  return {
    email:
      typeof claim === "string" && claim.trim().length > 0
        ? claim.trim().toLowerCase()
        : DEFAULT_GMAIL_EMAIL,
  };
}

export function resolveUserEmail(userId: string, session?: SessionValue): string {
  const identity = identityFromSession(session);
  const requested = decodeURIComponent(userId).toLowerCase();
  if (requested !== "me" && requested !== identity.email) notFound("User");
  return identity.email;
}

export function requireMailbox(db: GmailTwinDatabase, email: string): { id: number; email: string } {
  const row = db
    .prepare("SELECT id, email FROM mailboxes WHERE email = ? COLLATE NOCASE")
    .get(email) as { id: number; email: string } | undefined;
  if (!row) notFound("User");
  return row;
}

export function resolveTokenAlias(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.POME_GMAIL_TOKEN ?? env.POME_AUTH_TOKEN;
}
