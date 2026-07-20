// SPDX-License-Identifier: Apache-2.0
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { sign } from "hono/jwt";
import { auth, gmail } from "@googleapis/gmail";
import { composeMime, createGmailTwinApp, encodeGmailRaw, type GmailStateSeed } from "../src/index.js";

const SID = "official-client";
const SECRET = "official-client-secret";
const EMAIL = "pome-agent@pome-twin.test";
let server: Server;
let rootUrl: string;
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
  const seed: GmailStateSeed = {
    primaryMailbox: { email: EMAIL, displayName: "Pome Agent" },
    clock: "2025-01-01T00:00:00.000Z",
  };
  const app = createGmailTwinApp({ seed, runId: "official-client-test" });
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  rootUrl = `http://127.0.0.1:${address.port}/s/${SID}/`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

function mime(subject: string, attachment?: string): Buffer {
  return composeMime({
    from: EMAIL,
    to: ["recipient@example.test"],
    subject,
    text: `official body ${subject}`,
    date: "2025-01-02T12:00:00.000Z",
    messageId: `${subject.toLowerCase().replace(/\W/g, "-")}@official.test`,
    attachments: attachment
      ? [{ filename: "official.txt", data: Buffer.from(attachment).toString("base64") }]
      : undefined,
  });
}

describe("pinned @googleapis/gmail smoke", () => {
  it(
    "uses the official client across the frozen launch workflows",
    async () => {
      const oauth = new auth.OAuth2();
      oauth.setCredentials({ access_token: token });
      const client = gmail({ version: "v1", auth: oauth });
      // Per-call rootUrl preserves the session path. googleapis-common's
      // global rootUrl rewriting keeps only the URL origin.
      const options = { rootUrl };

      const initial = await client.users.getProfile({ userId: "me" }, options);
      expect(initial.data.emailAddress).toBe(EMAIL);
      const startHistoryId = initial.data.historyId!;

      const jsonWrite = await client.users.messages.insert(
        {
          userId: "me",
          requestBody: { raw: encodeGmailRaw(mime("JSON", "official-attachment")) },
          internalDateSource: "dateHeader",
        },
        options
      );
      expect(jsonWrite.data.id).toBeTruthy();

      const mediaWrite = await client.users.messages.insert(
        {
          userId: "me",
          media: { mimeType: "message/rfc822", body: mime("Media").toString("utf8") },
        },
        options
      );
      expect(mediaWrite.data.id).toBeTruthy();

      const multipartWrite = await client.users.messages.insert(
        {
          userId: "me",
          requestBody: { labelIds: ["STARRED"] },
          media: { mimeType: "message/rfc822", body: mime("Multipart").toString("utf8") },
        },
        options
      );
      expect(multipartWrite.data.labelIds).toContain("STARRED");

      const listed = await client.users.messages.list({ userId: "me", maxResults: 2 }, options);
      expect(listed.data.messages).toHaveLength(2);
      const fetched = await client.users.messages.get(
        {
          userId: "me",
          id: jsonWrite.data.id!,
          format: "full",
        },
        options
      );
      const attachment = fetched.data.payload?.parts?.find((part) => part.body?.attachmentId);
      expect(attachment?.body?.attachmentId).toBeTruthy();
      const downloaded = await client.users.messages.attachments.get(
        {
          userId: "me",
          messageId: jsonWrite.data.id!,
          id: attachment!.body!.attachmentId!,
        },
        options
      );
      expect(Buffer.from(downloaded.data.data!, "base64url").toString()).toBe("official-attachment");

      const rawFetched = await client.users.messages.get(
        {
          userId: "me",
          id: jsonWrite.data.id!,
          format: "raw",
        },
        options
      );
      expect(Buffer.from(rawFetched.data.raw!, "base64url")).toEqual(mime("JSON", "official-attachment"));

      const draft = await client.users.drafts.create(
        {
          userId: "me",
          requestBody: { message: { raw: encodeGmailRaw(mime("Draft one")) } },
        },
        options
      );
      const updated = await client.users.drafts.update(
        {
          userId: "me",
          id: draft.data.id!,
          requestBody: { message: { raw: encodeGmailRaw(mime("Draft two")) } },
        },
        options
      );
      expect(updated.data.id).toBe(draft.data.id);
      expect(updated.data.message?.id).not.toBe(draft.data.message?.id);
      const sent = await client.users.drafts.send(
        {
          userId: "me",
          requestBody: { id: draft.data.id },
        },
        options
      );
      expect(sent.data.labelIds).toContain("SENT");

      const label = await client.users.labels.create(
        {
          userId: "me",
          requestBody: {
            name: "Official",
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          },
        },
        options
      );
      expect((await client.users.labels.get({ userId: "me", id: label.data.id! }, options)).data.name).toBe(
        "Official"
      );
      await client.users.labels.patch(
        {
          userId: "me",
          id: label.data.id!,
          requestBody: { name: "Official patched" },
        },
        options
      );

      const history = await client.users.history.list(
        {
          userId: "me",
          startHistoryId,
          maxResults: 500,
        },
        options
      );
      expect(history.data.historyId).toBeTruthy();
      expect(history.data.history?.length).toBeGreaterThan(0);
    },
    20_000
  );
});
