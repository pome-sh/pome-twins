// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  runParityCli,
  type FidelityInventory,
  type ParityStep,
} from "@pome-sh/sdk/parity";
import { createGmailTwinApp, gmailTools } from "../src/index.js";

const email = "pome-agent@pome-twin.test";
const launchToolNames = gmailTools.map((tool) => tool.name);
const rawInventory = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fidelity.inventory.json"), "utf8"),
) as {
  twin: string;
  package: string;
  updated: string;
  notes?: string;
  tools: Array<Record<string, unknown>>;
  rest: Array<Record<string, unknown>>;
};
const projectSurface = (surface: Record<string, unknown>) => ({
  name: surface.name,
  heat: surface.heat,
  fidelity: surface.fidelity,
  justification: surface.justification,
});
const launchInventory: FidelityInventory = {
  twin: rawInventory.twin,
  package: rawInventory.package,
  updated: rawInventory.updated,
  notes: rawInventory.notes,
  tools: rawInventory.tools
    .filter((tool) => launchToolNames.includes(String(tool.name)))
    .map(projectSurface),
  rest: rawInventory.rest.map(projectSurface),
  doc_drift: [],
} as FidelityInventory;

const seed = {
  primaryMailbox: {
    email,
    labels: [{ id: "Label_seed", name: "Parity Seed" }],
    messages: [
      {
        id: "msg_seed",
        threadId: "thread_seed",
        from: "alice@example.com",
        to: [email],
        subject: "Parity seed",
        text: "Unread parity message",
        date: "2026-07-19T12:00:00.000Z",
        messageId: "parity-seed@example.com",
        labels: ["INBOX", "UNREAD"],
      },
    ],
    drafts: [
      {
        id: "draft_seed",
        threadId: "thread_draft_seed",
        to: ["bob@example.com"],
        subject: "Existing draft",
        text: "Draft body",
        date: "2026-07-19T13:00:00.000Z",
        messageId: "parity-draft@example.com",
      },
    ],
  },
  deliveryMode: "sender-only" as const,
  clock: "2026-07-20T00:00:00.000Z",
};

const steps: ParityStep[] = [
  {
    tool: "create_draft",
    arguments: {
      to: ["bob@example.com"],
      subject: "Created by parity",
      body: "Parity body",
    },
  },
  { tool: "list_drafts", arguments: { pageSize: 20 } },
  {
    tool: "get_thread",
    arguments: { threadId: "thread_seed", messageFormat: "FULL_CONTENT" },
  },
  { tool: "search_threads", arguments: { query: "is:unread", pageSize: 20 } },
  {
    tool: "label_thread",
    arguments: { threadId: "thread_seed", labelIds: ["Label_seed"] },
  },
  {
    tool: "unlabel_thread",
    arguments: { threadId: "thread_seed", labelIds: ["Label_seed"] },
  },
  { tool: "list_labels", arguments: { pageSize: 50 } },
  {
    tool: "label_message",
    arguments: { messageId: "msg_seed", labelIds: ["STARRED"] },
  },
  {
    tool: "unlabel_message",
    arguments: { messageId: "msg_seed", labelIds: ["STARRED"] },
  },
  { tool: "create_label", arguments: { displayName: "Parity Complete" } },
];

await runParityCli({
  app: createGmailTwinApp({ seed }),
  twin: "gmail",
  inventory: launchInventory,
  liveToolNames: launchToolNames,
  steps,
  claims: { team_id: "tm_gmail", gmail_email: email },
  restProbes: [
    {
      surface: "named-gap:users.watch",
      method: "POST",
      path: "/gmail/v1/users/me/watch",
      status: 501,
    },
    {
      surface: "named-gap:users.stop",
      method: "POST",
      path: "/gmail/v1/users/me/stop",
      status: 501,
    },
  ],
});
