// SPDX-License-Identifier: Apache-2.0
//
// Hero events.jsonl × 2 — Stripe refund-retry (M0-1) + GitHub identity-spoof
// (M0-2). Both wrapped with synthetic adapter signals (the hero recordings
// pre-date the adapter-rich wiring; the .signals.jsonl files in
// ./fixtures/ stand in for what `@pome-sh/adapter-claude-sdk` would emit).
//
// Acceptance from FDRS-324:
// > Both hero events.jsonl (with adapter wrapping) → produces sensible lanes

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  recorderEventSchema,
  type RecorderEvent,
} from "@pome-sh/shared-types";
import { correlateAdapterRich } from "../src/index.js";
import { adapterSignalSchema, type AdapterSignal } from "../src/index.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

function loadEvents(name: string): RecorderEvent[] {
  const text = readFileSync(join(FIXTURES, name), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => recorderEventSchema.parse(JSON.parse(l)));
}

function loadSignals(name: string): AdapterSignal[] {
  const text = readFileSync(join(FIXTURES, name), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => adapterSignalSchema.parse(JSON.parse(l)));
}

describe("hero fixture: Stripe refund-retry-double-charge (M0-1)", () => {
  const events = loadEvents("hero-stripe-refund-retry.events.jsonl");
  const signals = loadSignals("hero-stripe-refund-retry.signals.jsonl");
  const out = correlateAdapterRich(events, signals);

  it("produces exactly one step (the wrapping refund-retry tool turn)", () => {
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]!.id).toBe("stp_refund_retry");
  });

  it("groups the 2 POST /v1/refunds calls into one lane and the GET /v1/charges into another", () => {
    expect(out.lanes).toHaveLength(2);
    const labels = out.lanes.map((l) => l.label);
    expect(labels).toContain("POST /v1/refunds (2 calls)");
    expect(labels).toContain("GET /v1/charges/ch_test_200 (1 call)");
  });

  it("every event is accounted for (zero dropped on the floor)", () => {
    const allRequestIds = out.lanes.flatMap((l) => l.request_ids).sort();
    const eventRequestIds = events.map((e) => e.request_id).sort();
    expect(allRequestIds).toEqual(eventRequestIds);
  });

  it("matches the recorded snapshot", () => {
    expect(out).toMatchSnapshot();
  });
});

describe("hero fixture: GitHub identity-spoof (M0-2)", () => {
  const events = loadEvents("hero-github-identity-spoof.events.jsonl");
  const signals = loadSignals("hero-github-identity-spoof.signals.jsonl");
  const out = correlateAdapterRich(events, signals);

  it("produces exactly one step (the wrapping review-PR tool turn)", () => {
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]!.id).toBe("stp_review_pr");
  });

  it("produces one lane per distinct (method, path) — 3 events → 3 lanes", () => {
    expect(out.lanes).toHaveLength(3);
    const labels = out.lanes.map((l) => l.label).sort();
    expect(labels).toEqual([
      "GET /repos/acme/server/collaborators (1 call)",
      "GET /repos/acme/server/pulls/1 (1 call)",
      "POST /repos/acme/server/pulls/1/reviews (1 call)",
    ]);
  });

  it("every event is accounted for (zero dropped on the floor)", () => {
    const allRequestIds = out.lanes.flatMap((l) => l.request_ids).sort();
    const eventRequestIds = events.map((e) => e.request_id).sort();
    expect(allRequestIds).toEqual(eventRequestIds);
  });

  it("matches the recorded snapshot", () => {
    expect(out).toMatchSnapshot();
  });
});
