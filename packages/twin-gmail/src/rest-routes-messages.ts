// SPDX-License-Identifier: Apache-2.0
import type { Hono } from "hono";
import {
  asInputError,
  booleanQuery,
  emailFromContext,
  messageFormat,
  normalizeListBinding,
  numberQuery,
  paginate,
  readJsonObject,
  rejectClassification,
  rejectUnsupportedQuery,
  repeatedQuery,
  routeParam,
  stringArray,
} from "./rest-common.js";
import type { GmailRouteKit } from "./rest-routes-kit.js";
import { readMessageWrite } from "./rest-upload.js";
import { invalidArgument } from "./errors.js";

const BASE = "/gmail/v1/users/:userId/messages";
const UPLOAD = "/upload/gmail/v1/users/:userId/messages";

export function registerMessageRoutes(app: Hono, kit: GmailRouteKit): void {
  const { serializers, domain } = kit;

  app.get(
    BASE,
    kit.read((c) => {
      const email = emailFromContext(c);
      const query = c.req.query("q") ?? "";
      const includeSpamTrash = booleanQuery(c, "includeSpamTrash");
      const labelIds = repeatedQuery(c, "labelIds");
      let messages = asInputError(() =>
        domain.searchMessages(email, query, { includeTrash: includeSpamTrash })
      );
      if (!/\bin:draft\b/i.test(query)) messages = messages.filter((message) => !message.labelIds.includes("DRAFT"));
      if (labelIds.length) {
        messages = messages.filter((message) => labelIds.every((labelId) => message.labelIds.includes(labelId)));
      }
      const maxResults = numberQuery(c, "maxResults", 100, 500);
      const snapshot = domain.currentHistoryIdFor(email);
      const binding = normalizeListBinding("messages.list", email, { query, includeSpamTrash, labelIds });
      const { page, nextPageToken } = paginate(messages, {
        maxResults,
        pageToken: c.req.query("pageToken"),
        binding,
        snapshot,
      });
      return {
        body: {
          ...(page.length ? { messages: page.map((message) => ({ id: message.id, threadId: message.threadId })) } : {}),
          resultSizeEstimate: messages.length,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      };
    })
  );

  app.post(
    `${BASE}/batchModify`,
    kit.write(async (c) => {
      const email = emailFromContext(c);
      const body = await readJsonObject(c);
      rejectClassification(body);
      const ids = stringArray(body, "ids", 1000);
      if (!ids.length) invalidArgument("ids is required");
      const add = stringArray(body, "addLabelIds");
      const remove = stringArray(body, "removeLabelIds");
      domain.db.transaction(() => {
        for (const id of ids) domain.modifyMessageLabels(email, id, add, remove);
      }).immediate();
      return { body: {} };
    })
  );

  app.post(
    `${BASE}/batchDelete`,
    kit.write(async (c) => {
      const email = emailFromContext(c);
      const body = await readJsonObject(c);
      const ids = stringArray(body, "ids", 1000);
      if (!ids.length) invalidArgument("ids is required");
      domain.batchDeleteMessages(email, ids);
      return { status: 204, body: null };
    })
  );

  const send = kit.write(async (c) => {
    const email = emailFromContext(c);
    const input = await readMessageWrite(c);
    const result = asInputError(() => domain.sendMessage(email, input.raw, { threadId: input.threadId }));
    return { body: serializers.message(email, result.sender, "full") };
  });
  app.post(`${BASE}/send`, send);
  app.post(`${UPLOAD}/send`, send);

  const importMessage = kit.write(async (c) => {
    const email = emailFromContext(c);
    rejectUnsupportedQuery(c, ["deleted", "processForCalendar"]);
    const source = internalDateSource(c, "dateHeader");
    booleanQuery(c, "neverMarkSpam");
    const input = await readMessageWrite(c);
    const inserted = asInputError(() =>
      domain.insertMessage(email, input.raw, {
        threadId: input.threadId,
        labels: input.labelIds,
        incoming: true,
      })
    );
    const message = domain.applyInternalDateSource(email, inserted.id, source);
    return { body: serializers.message(email, message, "full") };
  });
  app.post(`${BASE}/import`, importMessage);
  app.post(`${UPLOAD}/import`, importMessage);

  const insert = kit.write(async (c) => {
    const email = emailFromContext(c);
    rejectUnsupportedQuery(c, ["deleted"]);
    const source = internalDateSource(c, "receivedTime");
    const input = await readMessageWrite(c);
    const inserted = asInputError(() =>
      domain.insertMessage(email, input.raw, {
        threadId: input.threadId,
        labels: input.labelIds,
      })
    );
    const message = domain.applyInternalDateSource(email, inserted.id, source);
    return { body: serializers.message(email, message, "full") };
  });
  app.post(BASE, insert);
  app.post(UPLOAD, insert);

  app.get(
    `${BASE}/:id`,
    kit.read((c) => {
      const email = emailFromContext(c);
      const format = messageFormat(c);
      const message = domain.getMessage(email, routeParam(c, "id"));
      return { body: serializers.message(email, message, format, repeatedQuery(c, "metadataHeaders")) };
    })
  );

  app.post(
    `${BASE}/:id/modify`,
    kit.write(async (c) => {
      const email = emailFromContext(c);
      const body = await readJsonObject(c);
      rejectClassification(body);
      const message = domain.modifyMessageLabels(
        email,
        routeParam(c, "id"),
        stringArray(body, "addLabelIds"),
        stringArray(body, "removeLabelIds")
      );
      return { body: serializers.message(email, message, "minimal") };
    })
  );

  app.post(
    `${BASE}/:id/trash`,
    kit.write((c) => {
      const email = emailFromContext(c);
      const message = domain.modifyMessageLabels(email, routeParam(c, "id"), ["TRASH"], ["INBOX"]);
      return { body: serializers.message(email, message, "minimal") };
    })
  );

  app.post(
    `${BASE}/:id/untrash`,
    kit.write((c) => {
      const email = emailFromContext(c);
      const message = domain.modifyMessageLabels(email, routeParam(c, "id"), [], ["TRASH"]);
      return { body: serializers.message(email, message, "minimal") };
    })
  );

  app.delete(
    `${BASE}/:id`,
    kit.write((c) => {
      domain.deleteMessage(emailFromContext(c), routeParam(c, "id"));
      return { status: 204, body: null };
    })
  );

  app.get(
    `${BASE}/:messageId/attachments/:id`,
    kit.read((c) => ({
      body: domain.attachment(emailFromContext(c), routeParam(c, "messageId"), routeParam(c, "id")),
    }))
  );

  for (const path of [
    "/resumable/upload/gmail/v1/users/:userId/messages",
    "/resumable/upload/gmail/v1/users/:userId/messages/send",
    "/resumable/upload/gmail/v1/users/:userId/messages/import",
  ]) {
    app.post(path, kit.unsupported("Resumable Gmail uploads are not supported"));
    app.put(path, kit.unsupported("Resumable Gmail uploads are not supported"));
  }
}

function internalDateSource(
  c: Parameters<typeof emailFromContext>[0],
  fallback: "receivedTime" | "dateHeader"
): "receivedTime" | "dateHeader" {
  const value = c.req.query("internalDateSource") ?? fallback;
  if (value !== "receivedTime" && value !== "dateHeader") invalidArgument("Invalid internalDateSource");
  return value;
}
