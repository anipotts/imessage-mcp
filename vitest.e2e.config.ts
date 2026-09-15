import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: { IMESSAGE_UPDATE_CHECK: "0" },
  },
});
