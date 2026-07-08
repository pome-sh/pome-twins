// SPDX-License-Identifier: Apache-2.0
// Unit tests for the shared upload/finalize helpers (FDRS-656 review fixes).

import { describe, it, expect, vi, afterEach } from "vitest";
import { redactJsonl, uploadRunBlobs, type UploadClient } from "../../../src/hosted/uploadAndFinalize.js";
import { HostedOrchError } from "../../../src/hosted/errors.js";

describe("redactJsonl (FDRS-656 review)", () => {
  it("drops whitespace-only lines so validation and upload agree on row counts", () => {
    // validateJsonl trims lines before parsing, so a " " line passes
    // validation — it must never reach cloud as a non-JSON row.
    const out = redactJsonl('   \n{"a":1}\n\t\n');
    expect(out).toBe('{"a":1}\n');
  });

  it("keeps redacting secrets per line", () => {
    const out = redactJsonl('{"api_key":"redaction_fixture_secret"}\n');
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("redaction_fixture_secret");
  });

  it("returns empty string for whitespace-only payloads", () => {
    expect(redactJsonl(" \n  \n")).toBe("");
  });
});

// D18.1 — meta.json upload is best-effort, exactly like the other three
// blobs: a happy-path PUT resolves to the returned key, and ANY failure
// (crucially including the 404 a control plane that predates
// `POST /v1/sessions/:id/meta-upload-url` returns — the route ships in a
// parallel pome-cloud PR) degrades to metaKey=null instead of throwing.
describe("uploadRunBlobs — meta.json (D18.1)", () => {
  const BLOBS = {
    eventsJsonl: '{"kind":"TwinHttpEvent"}\n',
    stateInitialJson: "{}",
    stateFinalJson: "{}",
    signalsJsonl: "",
    metaJson: '{"spec_version":1}',
  };

  function baseClient(): UploadClient {
    return {
      requestEventsUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
      requestStateUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
      requestSignalsUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
      requestMetaUploadUrl: async () => {
        throw new HostedOrchError("not stubbed");
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads meta.json and returns the storage key on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const client: UploadClient = {
      ...baseClient(),
      requestMetaUploadUrl: async () => ({
        url: "https://signed.example/put-meta",
        key: "team-tm_x/session-ses_1/meta.json",
      }),
    };

    const keys = await uploadRunBlobs(client, "ses_1", BLOBS);
    expect(keys.metaKey).toBe("team-tm_x/session-ses_1/meta.json");
  });

  it("a 404 from meta-upload-url (older control plane) tolerates silently — metaKey=null, no throw", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client: UploadClient = {
      ...baseClient(),
      requestMetaUploadUrl: async () => {
        throw new HostedOrchError("no route", undefined, 404);
      },
    };

    const keys = await uploadRunBlobs(client, "ses_1", BLOBS);
    expect(keys.metaKey).toBeNull();
    // The 404 happened minting the URL — no PUT was ever attempted.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a PUT failure after a successful mint also degrades to metaKey=null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500 }),
    );
    const client: UploadClient = {
      ...baseClient(),
      requestMetaUploadUrl: async () => ({
        url: "https://signed.example/put-meta",
        key: "team-tm_x/session-ses_1/meta.json",
      }),
    };

    const keys = await uploadRunBlobs(client, "ses_1", BLOBS);
    expect(keys.metaKey).toBeNull();
  });
});
