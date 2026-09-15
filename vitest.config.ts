import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: { IMESSAGE_UPDATE_CHECK: "0" },
  },
});
