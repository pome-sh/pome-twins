// SPDX-License-Identifier: Apache-2.0
// FDRS-643 test fixture — structural MIRROR of the cloud's demo model-call
// gateway request schema (pome-cloud apps/control-plane/src/routes/demo-llm.ts,
// FDRS-637). The strictness IS the contract: a `system` role, a `model`
// field, or any unknown key is a 422 on the real gateway, so the stub
// servers in these tests validate with the same shape to prove the CLI's
// wire bodies would survive the real thing. Any change to the server schema
// must be reflected here (and vice versa).

import { z } from "zod";

const MAX_TEXT_CHARS = 32_000;

const toolCallPartSchema = z
  .object({
    type: z.literal("tool-call"),
    toolCallId: z.string().min(1).max(200),
    toolName: z.string().min(1).max(64),
    input: z.unknown(),
  })
  .strict();

const toolResultPartSchema = z
  .object({
    type: z.literal("tool-result"),
    toolCallId: z.string().min(1).max(200),
    toolName: z.string().min(1).max(64),
    output: z.unknown(),
  })
  .strict();

const messageSchema = z.union([
  z
    .object({
      role: z.literal("user"),
      content: z.string().min(1).max(MAX_TEXT_CHARS),
    })
    .strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.union([
        z.string().max(MAX_TEXT_CHARS),
        z
          .array(
            z.union([
              z
                .object({
                  type: z.literal("text"),
                  text: z.string().max(MAX_TEXT_CHARS),
                })
                .strict(),
              toolCallPartSchema,
            ]),
          )
          .min(1)
          .max(32),
      ]),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: z.array(toolResultPartSchema).min(1).max(32),
    })
    .strict(),
]);

const toolDefSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    description: z.string().max(2000).optional(),
    input_schema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const demoLlmRequestSchema = z
  .object({
    task_name: z.string().min(1).max(200),
    messages: z.array(messageSchema).min(1).max(200),
    tools: z.array(toolDefSchema).max(32).optional(),
  })
  .strict();
