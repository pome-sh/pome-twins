// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import type { LinearOrganization, LinearTeam, LinearUser, LinearWebhook } from "../types.js";
import { webhookDestinationBlocked } from "../webhook-policy.js";

export type LinearWebhookEvent = {
  type: string;
  action: string;
  data: unknown;
  actor?: LinearUser | null;
  teamId?: string | null;
  url?: string | null;
  updatedFrom?: Record<string, unknown>;
};

/** Structural host for webhook delivery — avoids a domain ↔ dispatch import cycle. */
export type LinearWebhookHost = {
  getOrganization(): LinearOrganization | null;
  listWebhooks(): LinearWebhook[];
  getTeam(ref: string): LinearTeam | null;
  nextId(namespace?: string): string;
  now(): string;
  recordWebhookDelivery(input: {
    id: string;
    webhookId: string;
    event: string;
    action: string;
    url: string;
    status: number | null;
    error: string | null;
    payload: unknown;
    headers: Record<string, string>;
  }): void;
};

export async function dispatchLinearWebhook(
  commands: LinearWebhookHost,
  event: LinearWebhookEvent
): Promise<void> {
  const organization = commands.getOrganization();
  const webhooks = commands.listWebhooks().filter((webhook) => matchesWebhook(commands, webhook, event));

  for (const webhook of webhooks) {
    // Deterministic delivery id from the shared logical counter — a random id
    // would leak into /_pome/state and break run-to-run determinism.
    const deliveryId = commands.nextId("webhook_delivery");
    const payload = {
      action: event.action,
      type: event.type,
      actor: event.actor
        ? {
            id: event.actor.id,
            name: event.actor.name,
            displayName: event.actor.displayName,
            email: event.actor.email,
          }
        : null,
      data: event.data,
      url: event.url ?? null,
      createdAt: commands.now(),
      organizationId: organization?.id ?? null,
      webhookTimestamp: Date.parse(commands.now()),
      webhookId: webhook.id,
      ...(event.updatedFrom ? { updatedFrom: event.updatedFrom } : {}),
    };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Accept-Charset": "utf-8",
      "Content-Type": "application/json; charset=utf-8",
      "Linear-Delivery": deliveryId,
      "Linear-Event": event.type,
      "User-Agent": "Linear-Webhook",
    };
    if (webhook.secret) {
      headers["Linear-Signature"] = createHmac("sha256", webhook.secret).update(body).digest("hex");
    }

    let status: number | null = null;
    let error: string | null = null;
    // Default-deny SSRF guard: refuse loopback/private/link-local (incl. cloud
    // metadata) destinations before any request leaves the process. redirect:"error"
    // only covers redirect-based bypasses; this covers the initial request too.
    if (await webhookDestinationBlocked(webhook.url)) {
      error = "blocked_destination";
    } else {
      try {
        const res = await fetch(webhook.url, {
          method: "POST",
          headers,
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
      } catch (err) {
        // Normalize to a stable classification — raw fetch error messages are
        // platform/Node-version specific and would make exported state non-deterministic.
        error = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "delivery_failed";
      }
    }

    commands.recordWebhookDelivery({
      id: deliveryId,
      webhookId: webhook.id,
      event: event.type,
      action: event.action,
      url: webhook.url,
      status,
      error,
      payload,
      headers,
    });
  }
}

function matchesWebhook(
  commands: LinearWebhookHost,
  webhook: LinearWebhook,
  event: LinearWebhookEvent
): boolean {
  if (!webhook.enabled) return false;
  if (!webhook.resourceTypes.includes(event.type) && !webhook.resourceTypes.includes("*")) {
    return false;
  }
  if (webhook.allPublicTeams) {
    if (!event.teamId) return true;
    const team = commands.getTeam(event.teamId);
    return team ? !team.private : true;
  }
  return webhook.teamId === event.teamId;
}
