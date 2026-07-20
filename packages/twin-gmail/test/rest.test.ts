// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import {
  composeMime,
  createGmailTwinApp,
  encodeGmailRaw,
  openGmailTwinDatabase,
  type GmailStateSeed,
} from "../src/index.js";

const SID = "gmail-rest";
const SECRET = "gmail-rest-test-secret";
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
    primaryMailbox: {
      email: EMAIL,
      displayName: "Pome Agent",
      labels: [{ name: "Seeded" }],
      filters: [{ criteria: { subject: "seed" }, action: { addLabelIds: ["INBOX"] } }],
      forwardingAddresses: [{ forwardingEmail: "forward@example.test", verificationStatus: "accepted" }],
      sendAs: [{ sendAsEmail: "alias@example.test", displayName: "Alias", verificationStatus: "accepted" }],
    },
    clock: "2025-01-01T00:00:00.000Z",
  };
}

function fixture() {
  const db = openGmailTwinDatabase(":memory:");
  const app = createGmailTwinApp({ db, seed: seed(), runId: "rest-test" });
  const request = async (path: string, init: RequestInit = {}) =>
    app.request(`/s/${SID}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
  return { app, db, request };
}

function raw(subject: string, attachment?: string): Buffer {
  return composeMime({
    from: EMAIL,
    to: ["recipient@example.test"],
    subject,
    text: `body for ${subject}`,
    date: "2025-01-01T12:00:00.000Z",
    messageId: `${subject.toLowerCase().replace(/\W/g, "-")}@test`,
    attachments: attachment
      ? [{ filename: "proof.txt", mimeType: "text/plain", data: Buffer.from(attachment).toString("base64") }]
      : undefined,
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

describe("Gmail REST routes", () => {
  it("serves profile, message projections, attachments, and opaque pagination", async () => {
    const { request } = fixture();
    const profile = await request("/gmail/v1/users/me/profile");
    expect(profile.status).toBe(200);
    expect(await json(profile)).toMatchObject({ emailAddress: EMAIL, messagesTotal: 0, threadsTotal: 0 });

    const createdIds: string[] = [];
    for (const subject of ["Alpha", "Beta", "Gamma"]) {
      const response = await request("/gmail/v1/users/me/messages?internalDateSource=dateHeader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw: encodeGmailRaw(raw(subject, subject === "Alpha" ? "attachment-data" : undefined)) }),
      });
      expect(response.status).toBe(200);
      createdIds.push((await json(response)).id);
    }

    const first = await json(await request("/gmail/v1/users/me/messages?maxResults=1"));
    expect(first.messages).toHaveLength(1);
    expect(first.nextPageToken).toMatch(/\./);
    const second = await json(
      await request(`/gmail/v1/users/me/messages?maxResults=1&pageToken=${encodeURIComponent(first.nextPageToken)}`)
    );
    expect(second.messages[0].id).not.toBe(first.messages[0].id);
    const rebound = await request(
      `/gmail/v1/users/me/messages?maxResults=1&q=other&pageToken=${encodeURIComponent(first.nextPageToken)}`
    );
    expect(rebound.status).toBe(400);
    expect((await request("/gmail/v1/users/me/messages?q=%28unclosed")).status).toBe(400);
    expect((await request("/gmail/v1/users/other%40example.test/profile")).status).toBe(404);

    const full = await json(await request(`/gmail/v1/users/me/messages/${createdIds[0]}?format=full`));
    expect(full.payload.headers).toEqual(expect.arrayContaining([{ name: "Subject", value: "Alpha" }]));
    const attachment = full.payload.parts.find((part: any) => part.body.attachmentId);
    const downloaded = await json(
      await request(
        `/gmail/v1/users/me/messages/${createdIds[0]}/attachments/${attachment.body.attachmentId}`
      )
    );
    expect(Buffer.from(downloaded.data, "base64url").toString()).toBe("attachment-data");

    const metadata = await json(
      await request(`/gmail/v1/users/me/messages/${createdIds[0]}?format=metadata&metadataHeaders=Subject`)
    );
    expect(metadata.payload.headers).toEqual([{ name: "Subject", value: "Alpha" }]);
    const rawResponse = await json(await request(`/gmail/v1/users/me/messages/${createdIds[0]}?format=raw`));
    expect(Buffer.from(rawResponse.raw, "base64url")).toEqual(raw("Alpha", "attachment-data"));
  });

  it("implements message labels, batch operations, trash, threads, and deletes", async () => {
    const { request } = fixture();
    const created = await json(
      await request("/gmail/v1/users/me/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw: encodeGmailRaw(raw("Mutations")) }),
      })
    );
    const label = await json(
      await request("/gmail/v1/users/me/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Project" }),
      })
    );
    const modified = await json(
      await request(`/gmail/v1/users/me/messages/${created.id}/modify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addLabelIds: [label.id] }),
      })
    );
    expect(modified.labelIds).toContain(label.id);

    const thread = await json(await request(`/gmail/v1/users/me/threads/${created.threadId}`));
    expect(thread.messages).toHaveLength(1);
    expect(
      (
        await json(
          await request(`/gmail/v1/users/me/threads/${created.threadId}/trash`, { method: "POST" })
        )
      ).messages[0].labelIds
    ).toContain("TRASH");
    await request(`/gmail/v1/users/me/threads/${created.threadId}/untrash`, { method: "POST" });

    expect(
      (
        await request("/gmail/v1/users/me/messages/batchModify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [created.id], addLabelIds: ["STARRED"] }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await request("/gmail/v1/users/me/messages/batchDelete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [created.id] }),
        })
      ).status
    ).toBe(204);
    expect((await request(`/gmail/v1/users/me/messages/${created.id}`)).status).toBe(404);
  });

  it("supports draft replacement/send and settings resources", async () => {
    const { request } = fixture();
    const draft = await json(
      await request("/gmail/v1/users/me/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { raw: encodeGmailRaw(raw("Draft one")) } }),
      })
    );
    const updated = await json(
      await request(`/gmail/v1/users/me/drafts/${draft.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { raw: encodeGmailRaw(raw("Draft two")) } }),
      })
    );
    expect(updated.id).toBe(draft.id);
    expect(updated.message.id).not.toBe(draft.message.id);
    const sent = await json(
      await request("/gmail/v1/users/me/drafts/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draft.id }),
      })
    );
    expect(sent.labelIds).toContain("SENT");
    expect((await request(`/gmail/v1/users/me/drafts/${draft.id}`)).status).toBe(404);

    expect((await json(await request("/gmail/v1/users/me/settings/filters"))).filter).toHaveLength(1);
    const filter = await json(
      await request("/gmail/v1/users/me/settings/filters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ criteria: { from: "sender@example.test" }, action: { addLabelIds: ["STARRED"] } }),
      })
    );
    expect((await json(await request(`/gmail/v1/users/me/settings/filters/${filter.id}`))).id).toBe(filter.id);
    expect((await request(`/gmail/v1/users/me/settings/filters/${filter.id}`, { method: "DELETE" })).status).toBe(204);
    expect(
      (await json(await request("/gmail/v1/users/me/settings/forwardingAddresses"))).forwardingAddresses
    ).toHaveLength(1);
    expect((await json(await request("/gmail/v1/users/me/settings/sendAs"))).sendAs).toHaveLength(2);
  });

  it("returns loud 501 envelopes without side effects", async () => {
    const { db, request } = fixture();
    const count = () => (db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count;
    for (const [path, body] of [
      ["/gmail/v1/users/me/watch", {}],
      ["/gmail/v1/users/me/stop", {}],
      ["/gmail/v1/users/me/messages?deleted=true", { raw: encodeGmailRaw(raw("Deleted")) }],
      [
        "/gmail/v1/users/me/messages",
        { raw: encodeGmailRaw(raw("Classified")), classificationLabelValues: [{ labelId: "drive-label" }] },
      ],
      [
        "/gmail/v1/users/me/messages/import?processForCalendar=true",
        { raw: encodeGmailRaw(raw("Calendar")) },
      ],
      [
        "/gmail/v1/users/me/settings/filters",
        { criteria: {}, action: { forward: "outside@example.test" } },
      ],
    ] as const) {
      const response = await request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(501);
      expect(await json(response)).toMatchObject({ error: { code: 501, status: "UNIMPLEMENTED" } });
    }
    expect(count()).toBe(0);
  });

  it("supports simple media and multipart/related uploads", async () => {
    const { request } = fixture();
    const media = await request("/upload/gmail/v1/users/me/messages?uploadType=media", {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: raw("Media"),
    });
    expect(media.status).toBe(200);

    const boundary = "pome-test-boundary";
    const mime = raw("Multipart");
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"labelIds":["STARRED"]}\r\n` +
          `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`
      ),
      mime,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await request("/upload/gmail/v1/users/me/messages?uploadType=multipart", {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    expect(response.status).toBe(200);
    expect((await json(response)).labelIds).toContain("STARRED");
    expect(
      (
        await request("/resumable/upload/gmail/v1/users/me/messages", {
          method: "POST",
          headers: { "content-type": "message/rfc822" },
          body: raw("Nope"),
        })
      ).status
    ).toBe(501);
  });
});
