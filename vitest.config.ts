import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["tests/convex/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
