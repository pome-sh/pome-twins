import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Socket-boundary tests drive a real @modelcontextprotocol/sdk handshake
    // over a listening socket; on a contended CI runner the sequential
    // round-trips can cross vitest's 5s default (twin-github and twin-stripe
    // already run with this 30s budget).
    testTimeout: 30_000,
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
