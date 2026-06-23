import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      POME_CLI_DISABLE_KEYCHAIN: "1",
    },
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    isolate: true,
    exclude: ["node_modules/**", "dist/**", "runs/**"]
  }
});
