// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  runParityCli,
  type FidelityInventory,
  type ParityStep,
} from "@pome-sh/sdk/parity";
import { composeMime, createGmailTwinApp, encodeGmailRaw, gmailTools } from "../src/index.js";

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
      {
        id: "msg_trash_target",
        threadId: "thread_trash_target",
        from: "trash@example.com",
        to: [email],
        subject: "Trash target",
        text: "Disposable sensitive-label thread target",
        date: "2026-07-19T12:30:00.000Z",
        messageId: "trash-target@example.com",
        labels: ["INBOX"],
      },
      {
        id: "msg_spam_target",
        threadId: "thread_spam_target",
        from: "spam@example.com",
        to: [email],
        subject: "Spam target",
        text: "Disposable sensitive-label message target",
        date: "2026-07-19T12:31:00.000Z",
        messageId: "spam-target@example.com",
        labels: ["INBOX"],
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
  {
    tool: "get_message",
    arguments: { messageId: "msg_seed", messageFormat: "FULL_CONTENT" },
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
  {
    tool: "apply_sensitive_thread_label",
    arguments: { threadId: "thread_trash_target", labelOption: "TRASH" },
  },
  {
    tool: "apply_sensitive_message_label",
    arguments: { messageId: "msg_spam_target", labelOption: "SPAM" },
  },
];

const sendRaw = encodeGmailRaw(
  composeMime({
    from: email,
    to: ["parity-recipient@example.com"],
    subject: "Parity send probe",
    text: "Sent by fidelity:parity REST probe",
    date: "2026-07-20T01:00:00.000Z",
    messageId: "parity-send@pome-twin.test",
  }),
);

await runParityCli({
  app: createGmailTwinApp({ seed }),
  twin: "gmail",
  inventory: launchInventory,
  liveToolNames: launchToolNames,
  steps,
  claims: { team_id: "tm_gmail", gmail_email: email },
  restProbes: [
    {
      surface: "users.getProfile",
      method: "GET",
      path: "/gmail/v1/users/me/profile",
      status: 200,
      verify: (body) => {
        const profile = body as { emailAddress?: string; historyId?: string };
        if (profile.emailAddress !== email) return `expected emailAddress ${email}`;
        if (!profile.historyId) return "expected historyId";
        return undefined;
      },
    },
    {
      surface: "users.messages.list",
      method: "GET",
      path: "/gmail/v1/users/me/messages?maxResults=10",
      status: 200,
      verify: (body) => {
        const list = body as { messages?: Array<{ id: string }> };
        if (!list.messages?.some((message) => message.id === "msg_seed")) {
          return "expected seeded msg_seed in messages.list";
        }
        return undefined;
      },
    },
    {
      surface: "users.messages.get",
      method: "GET",
      path: "/gmail/v1/users/me/messages/msg_seed?format=metadata",
      status: 200,
      verify: (body) => {
        const message = body as { id?: string; threadId?: string };
        if (message.id !== "msg_seed" || message.threadId !== "thread_seed") {
          return "expected msg_seed / thread_seed";
        }
        return undefined;
      },
    },
    {
      surface: "users.messages.send",
      method: "POST",
      path: "/gmail/v1/users/me/messages/send",
      status: 200,
      body: JSON.stringify({ raw: sendRaw }),
      verify: (body) => {
        const message = body as { id?: string; labelIds?: string[] };
        if (!message.id) return "expected sent message id";
        if (!message.labelIds?.includes("SENT")) return "expected SENT label";
        return undefined;
      },
    },
    {
      surface: "users.drafts.list",
      method: "GET",
      path: "/gmail/v1/users/me/drafts",
      status: 200,
      verify: (body) => {
        const drafts = body as { drafts?: Array<{ id: string }> };
        if (!drafts.drafts?.some((draft) => draft.id === "draft_seed")) {
          return "expected seeded draft_seed";
        }
        return undefined;
      },
    },
    {
      surface: "users.labels.list",
      method: "GET",
      path: "/gmail/v1/users/me/labels",
      status: 200,
      verify: (body) => {
        const labels = body as { labels?: Array<{ id?: string; name?: string }> };
        if (!labels.labels?.some((label) => label.id === "Label_seed" || label.name === "Parity Seed")) {
          return "expected Parity Seed label";
        }
        return undefined;
      },
    },
    {
      surface: "users.history.list",
      method: "GET",
      path: "/gmail/v1/users/me/history?startHistoryId=0",
      status: 200,
      verify: (body) => {
        const history = body as { historyId?: string };
        if (!history.historyId) return "expected historyId";
        return undefined;
      },
    },
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
