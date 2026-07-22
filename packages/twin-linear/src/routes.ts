// SPDX-License-Identifier: Apache-2.0
import type { RouteContext } from "@pome-sh/sdk";
import type { Hono } from "hono";
import type { LinearDomain } from "./domain/index.js";
import { registerGraphqlRoutes } from "./graphql/routes.js";

/**
 * Session-mounted routes (also available at root via mountSessionAtRoot).
 * OAuth is mounted publicly by `withPublicOAuth` — authorize/token/revoke
 * must not sit behind bearerAuth.
 */
export function registerLinearRoutes(app: Hono, ctx: RouteContext<LinearDomain>): void {
  registerGraphqlRoutes(app, ctx);
}
