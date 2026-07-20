// SPDX-License-Identifier: Apache-2.0
import type { Hono } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import type { GmailDomain } from "./domain.js";
import { registerDraftRoutes } from "./rest-routes-drafts.js";
import { GmailRouteKit } from "./rest-routes-kit.js";
import { registerMessageRoutes } from "./rest-routes-messages.js";
import { registerResourceRoutes } from "./rest-routes-resources.js";

export function registerGmailRoutes(app: Hono, context: RouteContext<GmailDomain>): void {
  const kit = new GmailRouteKit(context);
  registerMessageRoutes(app, kit);
  registerDraftRoutes(app, kit);
  registerResourceRoutes(app, kit);
}
