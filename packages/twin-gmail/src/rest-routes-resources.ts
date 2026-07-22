// SPDX-License-Identifier: Apache-2.0
import type { Hono } from "hono";
import {
  asInputError,
  booleanQuery,
  emailFromContext,
  messageFormat,
  normalizeListBinding,
  numberQuery,
  objectField,
  paginate,
  readJsonObject,
  repeatedQuery,
  routeParam,
  stringArray,
  stringField,
  type JsonObject,
} from "./rest-common.js";
import { invalidArgument } from "./errors.js";
import type { GmailRouteKit } from "./rest-routes-kit.js";
import { historyResource, labelDetail, labelSummary } from "./rest-serializers.js";
import type { SeedFilter } from "./types.js";

const USERS = "/gmail/v1/users/:userId";

export function registerResourceRoutes(app: Hono, kit: GmailRouteKit): void {
  const { serializers, domain } = kit;

  app.get(`${USERS}/profile`, kit.read((c) => ({ body: domain.profile(emailFromContext(c)) })));

  app.get(
    `${USERS}/threads`,
    kit.read((c) => {
      const email = emailFromContext(c);
      const query = c.req.query("q") ?? "";
      const includeSpamTrash = booleanQuery(c, "includeSpamTrash");
      const labelIds = repeatedQuery(c, "labelIds");
      let threads = asInputError(() =>
        domain.searchThreads(email, query, { includeTrash: includeSpamTrash })
      );
      if (labelIds.length) {
        threads = threads.filter((thread) => labelIds.every((label) => thread.labelIds.includes(label)));
      }
      const maxResults = numberQuery(c, "maxResults", 100, 500);
      const snapshot = domain.currentHistoryIdFor(email);
      const binding = normalizeListBinding("threads.list", email, { query, includeSpamTrash, labelIds });
      const { page, nextPageToken } = paginate(threads, {
        maxResults,
        pageToken: c.req.query("pageToken"),
        binding,
        snapshot,
      });
      return {
        body: {
          ...(page.length
            ? {
                threads: page.map((thread) => ({
                  id: thread.id,
                  historyId: domain.latestThreadHistory(email, thread.id),
                  ...(thread.messages.at(-1)?.snippet ? { snippet: thread.messages.at(-1)!.snippet } : {}),
                })),
              }
            : {}),
          resultSizeEstimate: threads.length,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      };
    })
  );

  app.get(
    `${USERS}/threads/:id`,
    kit.read((c) => {
      const email = emailFromContext(c);
      const format = messageFormat(c, false);
      return {
        body: serializers.thread(
          email,
          domain.getThread(email, routeParam(c, "id")),
          format as "minimal" | "full" | "metadata",
          repeatedQuery(c, "metadataHeaders")
        ),
      };
    })
  );

  app.post(
    `${USERS}/threads/:id/modify`,
    kit.write(async (c) => {
      const email = emailFromContext(c);
      const body = await readJsonObject(c);
      const thread = domain.modifyThreadLabels(
        email,
        routeParam(c, "id"),
        stringArray(body, "addLabelIds"),
        stringArray(body, "removeLabelIds")
      );
      return { body: serializers.thread(email, thread, "minimal") };
    })
  );

  app.post(
    `${USERS}/threads/:id/trash`,
    kit.write((c) => {
      const email = emailFromContext(c);
      return {
        body: serializers.thread(
          email,
          domain.modifyThreadLabels(email, routeParam(c, "id"), ["TRASH"], ["INBOX"]),
          "minimal"
        ),
      };
    })
  );

  app.post(
    `${USERS}/threads/:id/untrash`,
    kit.write((c) => {
      const email = emailFromContext(c);
      return {
        body: serializers.thread(
          email,
          domain.modifyThreadLabels(email, routeParam(c, "id"), [], ["TRASH"]),
          "minimal"
        ),
      };
    })
  );

  app.delete(
    `${USERS}/threads/:id`,
    kit.write((c) => {
      domain.deleteThread(emailFromContext(c), routeParam(c, "id"));
      return { status: 204, body: null };
    })
  );

  app.get(`${USERS}/labels`, kit.read((c) => ({ body: { labels: domain.labels(emailFromContext(c)).map(labelSummary) } })));
  app.get(
    `${USERS}/labels/:id`,
    kit.read((c) => ({ body: labelDetail(domain.label(emailFromContext(c), routeParam(c, "id"))) }))
  );

  app.post(
    `${USERS}/labels`,
    kit.write(async (c) => {
      const email = emailFromContext(c);
      const body = await readJsonObject(c);
      if (body.type !== undefined && body.type !== "user") invalidArgument("Only user labels can be created");
      const created = domain.createLabel(email, stringField(body, "name", true)!, colorInput(body));
      return { body: labelDetail(domain.label(email, created.id)) };
    })
  );

  app.put(
    `${USERS}/labels/:id`,
    kit.write(async (c) => {
      const body = await readJsonObject(c);
      const label = domain.updateLabel(
        emailFromContext(c),
        routeParam(c, "id"),
        { name: stringField(body, "name", true), color: colorInput(body) },
        true
      );
      return { body: labelDetail(label) };
    })
  );

  app.patch(
    `${USERS}/labels/:id`,
    kit.write(async (c) => {
      const body = await readJsonObject(c);
      const label = domain.updateLabel(
        emailFromContext(c),
        routeParam(c, "id"),
        { name: stringField(body, "name"), color: colorInput(body) },
        false
      );
      return { body: labelDetail(label) };
    })
  );

  app.delete(
    `${USERS}/labels/:id`,
    kit.write((c) => {
      domain.deleteLabel(emailFromContext(c), routeParam(c, "id"));
      return { status: 204, body: null };
    })
  );

  registerHistory(app, kit);
  registerSettings(app, kit);

  app.post(`${USERS}/watch`, kit.unsupported("users.watch requires Pub/Sub and is not supported"));
  app.post(`${USERS}/stop`, kit.unsupported("users.stop requires Pub/Sub and is not supported"));
}

function registerHistory(app: Hono, kit: GmailRouteKit): void {
  app.get(
    `${USERS}/history`,
    kit.read((c) => {
      const email = emailFromContext(c);
      const startHistoryId = c.req.query("startHistoryId");
      if (!startHistoryId) invalidArgument("startHistoryId is required");
      const historyTypes = repeatedQuery(c, "historyTypes");
      const allowed = new Set(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
      if (historyTypes.some((type) => !allowed.has(type))) invalidArgument("Invalid historyTypes");
      const result = kit.context.domain.listHistory(email, startHistoryId, {
        types: historyTypes.length ? historyTypes : undefined,
      });
      const labelId = c.req.query("labelId");
      const resources = result.history
        .filter((event) => !labelId || event.labelIds.includes(labelId))
        .map(historyResource)
        .filter((item): item is Record<string, unknown> => item !== null);
      const maxResults = numberQuery(c, "maxResults", 100, 500);
      const binding = normalizeListBinding("history.list", email, { startHistoryId, historyTypes, labelId });
      const { page, nextPageToken } = paginate(resources, {
        maxResults,
        pageToken: c.req.query("pageToken"),
        binding,
        snapshot: result.historyId,
      });
      return {
        body: {
          ...(page.length ? { history: page } : {}),
          historyId: result.historyId,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      };
    })
  );
}

function registerSettings(app: Hono, kit: GmailRouteKit): void {
  const { domain } = kit;
  app.get(
    `${USERS}/settings/filters`,
    kit.read((c) => ({ body: { filter: domain.filters(emailFromContext(c)) } }))
  );
  app.get(
    `${USERS}/settings/filters/:id`,
    kit.read((c) => ({ body: domain.filter(emailFromContext(c), routeParam(c, "id")) }))
  );
  app.post(
    `${USERS}/settings/filters`,
    kit.write(async (c) => {
      const body = await readJsonObject(c);
      return {
        body: asInputError(() =>
          domain.createFilter(
            emailFromContext(c),
            filterCriteria(objectField(body, "criteria") ?? {}),
            filterAction(objectField(body, "action") ?? {})
          )
        ),
      };
    })
  );
  app.delete(
    `${USERS}/settings/filters/:id`,
    kit.write((c) => {
      domain.deleteFilter(emailFromContext(c), routeParam(c, "id"));
      return { status: 204, body: null };
    })
  );

  app.get(
    `${USERS}/settings/forwardingAddresses`,
    kit.read((c) => ({ body: { forwardingAddresses: domain.forwardingAddresses(emailFromContext(c)) } }))
  );
  app.get(
    `${USERS}/settings/forwardingAddresses/:forwardingEmail`,
    kit.read((c) => ({
      body: domain.forwardingAddress(emailFromContext(c), decodeURIComponent(routeParam(c, "forwardingEmail"))),
    }))
  );
  app.get(
    `${USERS}/settings/sendAs`,
    kit.read((c) => ({ body: { sendAs: domain.sendAs(emailFromContext(c)) } }))
  );
  app.get(
    `${USERS}/settings/sendAs/:sendAsEmail`,
    kit.read((c) => ({
      body: domain.sendAsAddress(emailFromContext(c), decodeURIComponent(routeParam(c, "sendAsEmail"))),
    }))
  );
}

function colorInput(body: JsonObject): { textColor?: string; backgroundColor?: string } | undefined {
  const color = objectField(body, "color");
  if (!color) return undefined;
  return {
    textColor: stringField(color, "textColor"),
    backgroundColor: stringField(color, "backgroundColor"),
  };
}

function filterCriteria(body: JsonObject): SeedFilter["criteria"] {
  const criteria: NonNullable<SeedFilter["criteria"]> = {};
  for (const key of ["from", "to", "subject", "query", "negatedQuery"] as const) {
    const value = stringField(body, key);
    if (value !== undefined) criteria[key] = value;
  }
  for (const key of ["hasAttachment", "excludeChats"] as const) {
    const value = body[key];
    if (value !== undefined && typeof value !== "boolean") invalidArgument(`Invalid ${key}`);
    if (typeof value === "boolean") criteria[key] = value;
  }
  if (body.size !== undefined) {
    if (!Number.isInteger(body.size) || (body.size as number) < 0) invalidArgument("Invalid size");
    criteria.size = body.size as number;
  }
  if (body.sizeComparison !== undefined) {
    if (body.sizeComparison !== "larger" && body.sizeComparison !== "smaller") invalidArgument("Invalid sizeComparison");
    criteria.sizeComparison = body.sizeComparison;
  }
  return criteria;
}

function filterAction(body: JsonObject): SeedFilter["action"] {
  const addLabelIds = body.addLabelIds === undefined ? undefined : stringArray(body, "addLabelIds");
  const removeLabelIds = body.removeLabelIds === undefined ? undefined : stringArray(body, "removeLabelIds");
  const forward = stringField(body, "forward");
  return {
    ...(addLabelIds ? { addLabelIds } : {}),
    ...(removeLabelIds ? { removeLabelIds } : {}),
    ...(forward ? { forward } : {}),
  };
}
