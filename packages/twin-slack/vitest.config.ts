import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/server.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 65,
        statements: 84,
      },
    },
  },
});
