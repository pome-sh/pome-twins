import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // FDRS-437: the fixture-shape test imports the shared fidelity diff engine
      // (../../tools/fidelity/diff.ts + policy.ts). That engine is a separate,
      // independently-tested artifact (it is intentionally NOT a bun workspace,
      // decision D2) and must never enter twin-github's coverage denominator —
      // dragging ~500 mostly-unreached engine LOC in would sink this package
      // below its 90% floor for code it does not own. Scope coverage to this
      // package's own src/ and belt-and-braces exclude the out-of-tree engine
      // (defends against vitest enabling `all`/broadening include defaults).
      include: ["src/**"],
      exclude: ["../../tools/**", "**/tools/fidelity/**"],
      thresholds: {
        statements: 90,
        functions: 90,
        lines: 90
      }
    }
  }
});
