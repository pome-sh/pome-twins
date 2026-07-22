// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import {
  canonicalRaw,
  composeMime,
  createGmailTwinApp,
  encodeGmailRaw,
  GmailDomain,
  openGmailTwinDatabase,
  parseMime,
  parseSearchQuery,
  SEARCH_MAILBOX_MESSAGE_BUDGET,
  validateSearchQuery,
  type GmailStateSeed,
} from "../src/index.js";

const SID = "limits";
const SECRET = "limits-test-secret";
const EMAIL = "pome-agent@pome-twin.test";
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  token = await sign(
    {
      sid: SID,
      team_id: "team_test",
      gmail_email: EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SECRET
  );
});

function seed(): GmailStateSeed {
  return {
    primaryMailbox: { email: EMAIL, displayName: "Limits" },
    clock: "2025-01-01T00:00:00.000Z",
  };
}

function fixture() {
  const db = openGmailTwinDatabase(":memory:");
  const app = createGmailTwinApp({ db, seed: seed(), runId: "limits-test" });
  const request = async (path: string, init: RequestInit = {}) =>
    app.request(`/s/${SID}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
  return { app, db, request };
}

function domain() {
  const db = openGmailTwinDatabase(":memory:");
  const gmail = new GmailDomain(db);
  gmail.seed(seed());
  return gmail;
}

async function mcpCall(app: ReturnType<typeof createGmailTwinApp>, id: number, name: string, args: unknown) {
  const response = await app.request(`/s/${SID}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return response.json() as Promise<{ result: { isError?: boolean; content?: Array<{ text: string }> } }>;
}

describe("LIMITS.md max+1 enforcement", () => {
  it("rejects MIME over raw byte limit", () => {
    const over = Buffer.alloc(36_700_160 + 1, 0x61);
    expect(() => canonicalRaw(over)).toThrow(/exceeds/);
  });

  it("rejects MIME over header count and header byte limits", () => {
    const manyHeaders = Array.from({ length: 1001 }, (_, i) => `X-H${i}: v`).join("\r\n");
    expect(() =>
      parseMime(
        Buffer.from(
          `From: ${EMAIL}\r\nTo: a@test\r\nSubject: H\r\nMessage-ID: <h@test>\r\nDate: Wed, 01 Jan 2025 12:00:00 GMT\r\n${manyHeaders}\r\n\r\nbody\r\n`,
          "utf8"
        )
      )
    ).toThrow(/header count/);

    const fatHeader = `X-Fat: ${"x".repeat(262_145)}`;
    expect(() =>
      parseMime(
        Buffer.from(
          `From: ${EMAIL}\r\nTo: a@test\r\nSubject: H\r\nMessage-ID: <fat@test>\r\nDate: Wed, 01 Jan 2025 12:00:00 GMT\r\n${fatHeader}\r\n\r\nbody\r\n`,
          "utf8"
        )
      )
    ).toThrow(/headers exceed/);
  });

  it("rejects MIME over part and nesting depth limits", () => {
    const boundary = "pome-parts";
    const parts = Array.from({ length: 501 }, (_, i) =>
      [`--${boundary}`, "Content-Type: text/plain", "", `part-${i}`, ""].join("\r\n")
    ).join("");
    expect(() =>
      parseMime(
        Buffer.from(
          [
            `From: ${EMAIL}`,
            "To: a@test",
            "Subject: Parts",
            "Message-ID: <parts@test>",
            "Date: Wed, 01 Jan 2025 12:00:00 GMT",
            `Content-Type: multipart/mixed; boundary=${boundary}`,
            "",
            parts,
            `--${boundary}--`,
            "",
          ].join("\r\n"),
          "utf8"
        )
      )
    ).toThrow(/nesting\/part limit/);

    // 21 nested multiparts (depth max is 20): build from the inside out with
    // explicit header/body separators on every layer.
    let inner = Buffer.from("Content-Type: text/plain\r\n\r\nleaf\r\n", "utf8");
    for (let depth = 0; depth < 21; depth += 1) {
      const b = `bound${depth}`;
      inner = Buffer.from(
        `Content-Type: multipart/mixed; boundary=${b}\r\n\r\n--${b}\r\n${inner.toString("binary")}--${b}--\r\n`,
        "binary"
      );
    }
    expect(() =>
      parseMime(
        Buffer.from(
          `From: ${EMAIL}\r\nTo: a@test\r\nSubject: Deep\r\nMessage-ID: <deep@test>\r\nDate: Wed, 01 Jan 2025 12:00:00 GMT\r\n${inner.toString("binary")}`,
          "binary"
        )
      )
    ).toThrow(/nesting\/part limit/);
  });

  it("rejects search query byte/token/nesting max+1", () => {
    expect(() => parseSearchQuery("a".repeat(4097))).toThrow(/exceeds limit/);
    expect(() => parseSearchQuery(Array.from({ length: 257 }, (_, i) => `t${i}`).join(" "))).toThrow(
      /too many tokens/
    );
    expect(() => parseSearchQuery(`${"(".repeat(21)}x${")".repeat(21)}`)).toThrow(/nesting/);
    // Branch cap equals token cap for flat queries; token limit binds first on wide OR.
    expect(() => parseSearchQuery(Array.from({ length: 257 }, (_, i) => `w${i}`).join(" OR "))).toThrow(
      /too many tokens/
    );
    expect(parseSearchQuery(Array.from({ length: 128 }, (_, i) => `ok${i}`).join(" OR ")).type).toBe("or");
  });

  it("loud-rejects colored-star operators and accepts is:starred", () => {
    const gmail = domain();
    const message = gmail.insertMessage(
      EMAIL,
      composeMime({
        from: EMAIL,
        to: ["r@example.test"],
        subject: "Star",
        text: "body",
        date: "2025-01-01T12:00:00.000Z",
        messageId: "star@test",
      })
    );
    gmail.modifyMessageLabels(EMAIL, message.id, ["STARRED"]);
    expect(gmail.searchMessages(EMAIL, "is:starred")).toHaveLength(1);
    expect(() => gmail.searchMessages(EMAIL, "has:yellow-star")).toThrow(/colored-star/);
    expect(() => validateSearchQuery("has:blue-star")).toThrow(/colored-star/);
  });

  it("loud-fails search when mailbox exceeds in-memory budget", () => {
    const db = openGmailTwinDatabase(":memory:");
    const gmail = new GmailDomain(db);
    gmail.seed(seed());
    const mailboxId = gmail.mailboxId(EMAIL);
    const insert = db.prepare(
      `INSERT INTO messages(
        mailbox_id, id, thread_id, rfc_message_id, internal_date, sent_at,
        from_address, to_json, cc_json, bcc_json, delivered_to, subject, normalized_subject,
        snippet, text_body, html_body, headers_json, size_estimate
      ) VALUES (?, ?, ?, ?, 0, '', ?, '[]', '[]', '[]', '', '', '', '', '', '', '[]', 0)`
    );
    const blob = db.prepare(
      `INSERT INTO message_blobs(mailbox_id, message_id, sha256, size, raw) VALUES (?, ?, '00', 0, X'')`
    );
    const thread = db.prepare(
      `INSERT OR IGNORE INTO threads(mailbox_id, id, created_at, updated_at) VALUES (?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (let i = 0; i < SEARCH_MAILBOX_MESSAGE_BUDGET + 1; i += 1) {
        const id = `msg_budget_${i}`;
        const threadId = `thread_budget_${i}`;
        thread.run(mailboxId, threadId, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
        insert.run(mailboxId, id, threadId, `<budget-${i}@test>`, EMAIL);
        blob.run(mailboxId, id);
      }
    })();
    // Free-text cannot use the SQL prefilter; budget still guards the in-memory path.
    expect(() => gmail.searchMessages(EMAIL, "budget-sentinel-term")).toThrow(/in-memory search budget/);
  });

  it("rejects REST batch ids and maxResults max+1", async () => {
    const { request } = fixture();
    const ids = Array.from({ length: 1001 }, (_, i) => `msg_${i}`);
    const batch = await request("/gmail/v1/users/me/messages/batchModify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, addLabelIds: ["STARRED"] }),
    });
    expect(batch.status).toBe(400);

    const listed = await request("/gmail/v1/users/me/messages?maxResults=501");
    expect(listed.status).toBe(400);

    const drafts = await request("/gmail/v1/users/me/drafts?maxResults=501");
    expect(drafts.status).toBe(400);

    const threads = await request("/gmail/v1/users/me/threads?maxResults=501");
    expect(threads.status).toBe(400);
  });

  it("rejects MCP pageSize max+1", async () => {
    const { app } = fixture();
    const response = await mcpCall(app, 1, "search_threads", { query: "", pageSize: 51 });
    expect(response.result.isError).toBe(true);
  });

  it("rejects seed recipient and attachment count max+1", () => {
    const gmail = domain();
    expect(() =>
      gmail.seed({
        primaryMailbox: {
          email: EMAIL,
          messages: [
            {
              from: EMAIL,
              to: Array.from({ length: 501 }, (_, i) => `u${i}@example.test`),
              subject: "too many",
              text: "x",
              date: "2025-01-01T12:00:00.000Z",
            },
          ],
        },
      })
    ).toThrow();

    expect(() =>
      gmail.seed({
        primaryMailbox: {
          email: EMAIL,
          messages: [
            {
              from: EMAIL,
              to: ["a@example.test"],
              subject: "atts",
              text: "x",
              date: "2025-01-01T12:00:00.000Z",
              attachments: Array.from({ length: 101 }, (_, i) => ({
                filename: `f${i}.txt`,
                data: Buffer.from("x").toString("base64"),
              })),
            },
          ],
        },
      })
    ).toThrow();
  });

  it("accepts boundary-legal batch and page sizes", async () => {
    const { request, app } = fixture();
    const created = await (
      await request("/gmail/v1/users/me/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          raw: encodeGmailRaw(
            composeMime({
              from: EMAIL,
              to: ["r@example.test"],
              subject: "ok",
              text: "body",
              date: "2025-01-01T12:00:00.000Z",
              messageId: "ok@test",
            })
          ),
        }),
      })
    ).json() as { id: string };
    const batch = await request("/gmail/v1/users/me/messages/batchModify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [created.id], addLabelIds: ["STARRED"] }),
    });
    expect(batch.status).toBe(200);
    expect((await request("/gmail/v1/users/me/messages?maxResults=500")).status).toBe(200);
    const mcp = await mcpCall(app, 2, "list_labels", { pageSize: 50 });
    expect(mcp.result.isError).toBe(false);
  });
});
