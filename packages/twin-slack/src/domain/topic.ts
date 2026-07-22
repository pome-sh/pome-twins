// SPDX-License-Identifier: Apache-2.0
//
// conversations.setTopic / setPurpose (Wave 3 / SL4). Semantic warm fills —
// update the channel row and return a serialized channel. Membership is
// required for every channel type (real Slack); IM/MPIM are rejected.

import type { StateDelta } from "@pome-sh/shared-types";
import { slackError } from "../errors.js";
import { serializeChannel } from "../serializers.js";
import type { ChannelMemberRow, ChannelRow, SlackTwinDatabase } from "../types.js";

export type DeltaHook = (delta: StateDelta) => void;

export type TopicActor = { id: string };

export type TopicHost = {
  db: SlackTwinDatabase;
  requireChannel: (ref: string) => ChannelRow;
  actor: TopicActor;
};

const NOOP: DeltaHook = () => {};
const MAX_TOPIC_PURPOSE = 250;

export function conversationsSetTopic(
  host: TopicHost,
  args: { channel: string; topic: string },
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  return setChannelText(host, args.channel, "topic", args.topic, onDelta);
}

export function conversationsSetPurpose(
  host: TopicHost,
  args: { channel: string; purpose: string },
  onDelta: DeltaHook = NOOP
): Record<string, unknown> {
  return setChannelText(host, args.channel, "purpose", args.purpose, onDelta);
}

function setChannelText(
  host: TopicHost,
  channelRef: string,
  field: "topic" | "purpose",
  value: string | undefined,
  onDelta: DeltaHook
): Record<string, unknown> {
  if (value === undefined || value === null) {
    slackError("invalid_arguments", 400, {
      response_metadata: { messages: [`[ERROR] missing required field: ${field}`] },
    });
  }
  if (value!.length > MAX_TOPIC_PURPOSE) slackError("too_long", 400);
  const channel = host.requireChannel(channelRef);
  if (channel.is_im || channel.is_mpim) slackError("method_not_supported_for_channel_type", 400);
  if (channel.is_archived) slackError("is_archived", 400);
  const member = host.db
    .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?`)
    .get(channel.id, host.actor.id) as ChannelMemberRow | undefined;
  if (!member) slackError("not_in_channel", 400);

  const before = channel;
  const out = host.db.transaction(() => {
    host.db.prepare(`UPDATE channels SET ${field} = ? WHERE id = ?`).run(value!, channel.id);
    const after = host.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(channel.id) as ChannelRow;
    onDelta({ before, after });
    return { channel: serializeChannel(after) };
  })();
  return out;
}
