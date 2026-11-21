import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests don't load the Cloudflare plugin
// (unit tests use a fake AI binding and run in plain Node).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
