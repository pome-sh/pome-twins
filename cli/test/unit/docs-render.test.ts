// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  prepareDocSource,
  stripHeavyMdx,
  stripYamlFrontmatter,
} from "../../src/cli/docs-render.js";

describe("docs-render", () => {
  it("stripYamlFrontmatter removes leading --- block", () => {
    const raw = `---
title: "Hi"
---
Body`;
    expect(stripYamlFrontmatter(raw).trim()).toBe("Body");
  });

  it("stripHeavyMdx removes CardGroup blocks", () => {
    const raw = `Before
<CardGroup cols={2}>
  <Card title="A">text</Card>
</CardGroup>
After`;
    const cleaned = stripHeavyMdx(raw);
    expect(cleaned).toContain("Before");
    expect(cleaned).toContain("After");
    expect(cleaned).not.toContain("CardGroup");
  });

  it("prepareDocSource splits overview and ## sections", () => {
    const raw = `---
title: x
---
Intro line

## One

alpha

## Two

beta
`;
    const prepared = prepareDocSource(raw);
    expect(prepared.sections.length).toBeGreaterThanOrEqual(2);
    expect(prepared.sections[0]!.heading).toBe("Overview");
    expect(prepared.sections[0]!.bodyLines.join("\n")).toContain("Intro");
    expect(prepared.sections.some((s) => s.heading === "One")).toBe(true);
    expect(prepared.sections.some((s) => s.heading === "Two")).toBe(true);
  });
});
