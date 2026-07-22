#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { ensureTwinAuthSecret, serve } from "@pome-sh/sdk/server";
import { openGmailTwinDatabase } from "./db.js";
import { loadSeedFromEnv } from "./seed.js";
import { gmailTwinDefinition } from "./twin.js";

const port = Number(process.env.PORT ?? process.env.GMAIL_TWIN_PORT ?? 3336);
const host = process.env.GMAIL_TWIN_HOST ?? "127.0.0.1";
const dbPath = process.env.GMAIL_TWIN_DB ?? ".pome-data/gmail/gmail.db";

ensureTwinAuthSecret("gmail", host);
const db = openGmailTwinDatabase(dbPath);
const seed = process.env.GMAIL_TWIN_NO_SEED === "1" ? undefined : loadSeedFromEnv();

await serve(gmailTwinDefinition, {
  port,
  hostname: host,
  db,
  seed,
  runId: process.env.POME_RUN_ID ?? "spawn",
});

console.log(`Gmail twin listening at http://${host}:${port}`);
