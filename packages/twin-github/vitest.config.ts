import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Scope coverage to this package's own src/ only.
      include: ["src/**"],
      thresholds: {
        statements: 90,
        functions: 90,
        lines: 90
      }
    }
  }
});
