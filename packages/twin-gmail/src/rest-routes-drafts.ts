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
  routeParam,
} from "./rest-common.js";
import type { GmailRouteKit } from "./rest-routes-kit.js";
import { readDraftSend, readMessageWrite } from "./rest-upload.js";

const BASE = "/gmail/v1/users/:userId/drafts";
const UPLOAD = "/upload/gmail/v1/users/:userId/drafts";

export function registerDraftRoutes(app: Hono, kit: GmailRouteKit): void {
  const { context, serializers, store } = kit;
  const domain = context.domain;

  app.get(
    BASE,
    kit.read((c) => {
      const email = emailFromContext(c);
      const query = c.req.query("q") ?? "";
      const includeSpamTrash = booleanQuery(c, "includeSpamTrash");
      const drafts = asInputError(() => store.drafts(email, query, includeSpamTrash));
      const maxResults = numberQuery(c, "maxResults", 100, 500);
      const snapshot = store.currentHistoryIdFor(email);
      const binding = normalizeListBinding("drafts.list", email, { query, includeSpamTrash });
      const { page, nextPageToken } = paginate(drafts, {
        maxResults,
        pageToken: c.req.query("pageToken"),
        binding,
        snapshot,
      });
      return {
        body: {
          ...(page.length
            ? {
                drafts: page.map((draft) => ({
                  id: draft.id,
                  message: { id: draft.message.id, threadId: draft.message.threadId },
                })),
              }
            : {}),
          resultSizeEstimate: drafts.length,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      };
    })
  );

  const create = kit.write(async (c) => {
    const email = emailFromContext(c);
    const input = await readMessageWrite(c, true);
    const draft = asInputError(() => domain.createDraft(email, input.raw, { threadId: input.threadId }));
    return { body: serializers.draft(email, draft, "full") };
  });
  app.post(BASE, create);
  app.post(UPLOAD, create);

  const send = kit.write(async (c) => {
    const email = emailFromContext(c);
    const input = await readDraftSend(c);
    if (input.id) {
      if (input.message) {
        asInputError(() =>
          domain.updateDraft(email, input.id!, input.message!.raw, { threadId: input.message!.threadId })
        );
      }
      const sent = asInputError(() => domain.sendDraft(email, input.id!));
      return { body: serializers.message(email, sent.sender, "full") };
    }
    const sent = asInputError(() => domain.sendMessage(email, input.message!.raw, { threadId: input.message!.threadId }));
    return { body: serializers.message(email, sent.sender, "full") };
  });
  app.post(`${BASE}/send`, send);
  app.post(`${UPLOAD}/send`, send);

  app.get(
    `${BASE}/:id`,
    kit.read((c) => {
      const email = emailFromContext(c);
      return { body: serializers.draft(email, store.draft(email, routeParam(c, "id")), messageFormat(c)) };
    })
  );

  const update = kit.write(async (c) => {
    const email = emailFromContext(c);
    const input = await readMessageWrite(c, true);
    const draft = asInputError(() =>
      domain.updateDraft(email, routeParam(c, "id"), input.raw, { threadId: input.threadId })
    );
    return { body: serializers.draft(email, draft, "full") };
  });
  app.put(`${BASE}/:id`, update);
  app.put(`${UPLOAD}/:id`, update);

  app.delete(
    `${BASE}/:id`,
    kit.write((c) => {
      domain.deleteDraft(emailFromContext(c), routeParam(c, "id"));
      return { status: 204, body: null };
    })
  );

  for (const path of [
    "/resumable/upload/gmail/v1/users/:userId/drafts",
    "/resumable/upload/gmail/v1/users/:userId/drafts/send",
    "/resumable/upload/gmail/v1/users/:userId/drafts/:id",
  ]) {
    app.post(path, kit.unsupported("Resumable Gmail uploads are not supported"));
    app.put(path, kit.unsupported("Resumable Gmail uploads are not supported"));
  }
}
