// SPDX-License-Identifier: Apache-2.0
//
// Performance budgets — guard against regressions in the hot paths the
// twin uses on every agent step. Numbers are p95 over a small sample so
// CI noise doesn't flap; tighten as the implementation hardens.

import { beforeAll, describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";

const SEED_MESSAGE_COUNT = 1000;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

let seeded: { db: ReturnType<typeof openSlackTwinDatabase>; domain: SlackDomain };

beforeAll(() => {
  process.env.SLACK_DETERMINISTIC_TS = "1";
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  for (let i = 0; i < SEED_MESSAGE_COUNT; i += 1) {
    domain.chatPostMessage(
      { channel: "C_GENERAL", text: `bench message ${i} morning afternoon` },
      { login: "pome-agent" }
    );
  }
  seeded = { db, domain };
});

describe("performance budgets", () => {
  it("conversations.history p95 < 50ms over 100 calls", () => {
    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const start = performance.now();
      seeded.domain.conversationsHistory({ channel: "C_GENERAL", limit: 50 });
      samples.push(performance.now() - start);
    }
    expect(p95(samples)).toBeLessThan(50);
  });

  it("search.messages p95 < 100ms over 50 queries against 1000-message channel", () => {
    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const start = performance.now();
      seeded.domain.searchMessages({ query: "morning" });
      samples.push(performance.now() - start);
    }
    expect(p95(samples)).toBeLessThan(100);
  });

  // Budget raised 10ms → 30ms (F-684): the p95 sat at 10.2–12.6ms on shared
  // 2-core CI runners under concurrent workspace suites — pure SQLite insert
  // timing, no engine involvement (this calls the domain directly). A real
  // regression is an order-of-magnitude signal; 30ms keeps that intent
  // without flaking on runner load.
  it("chat.postMessage p95 < 30ms over 100 sequential inserts", () => {
    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const start = performance.now();
      seeded.domain.chatPostMessage(
        { channel: "C_GENERAL", text: `latency probe ${i}` },
        { login: "pome-agent" }
      );
      samples.push(performance.now() - start);
    }
    expect(p95(samples)).toBeLessThan(30);
  });

  it("conversations.list returns first page in < 20ms with 1000+ messages seeded", () => {
    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const start = performance.now();
      seeded.domain.conversationsList({ limit: 20 });
      samples.push(performance.now() - start);
    }
    expect(p95(samples)).toBeLessThan(20);
  });
});
