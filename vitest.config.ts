import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // the end-to-end suite launches dist/, so it runs after a build via npm run e2e.
    exclude: ["tests/e2e.test.ts", "node_modules/**"],
    env: { IMESSAGE_UPDATE_CHECK: "0" },
  },
});
