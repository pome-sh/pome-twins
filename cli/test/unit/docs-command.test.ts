// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DOCS_TOPICS } from "../../src/cli/docs-topics.js";
import { findTopic, suggestTopics } from "../../src/cli/docs.js";

describe("pome docs helpers", () => {
  it("findTopic resolves id and keywords", () => {
    expect(findTopic("getting-started", DOCS_TOPICS)?.id).toBe("getting-started");
    expect(findTopic("install", DOCS_TOPICS)?.id).toBe("getting-started");
  });

  it("suggestTopics lists nearby ids for unknown input", () => {
    const msg = suggestTopics("instal", DOCS_TOPICS);
    expect(msg).toContain("Did you mean");
    expect(msg).toContain("getting-started");
  });

  it("suggestTopics falls back to index hint when no overlap", () => {
    const msg = suggestTopics("zzzz-not-a-topic", DOCS_TOPICS);
    expect(msg).toContain("pome docs");
    expect(msg).toContain("zzzz-not-a-topic");
  });
});
