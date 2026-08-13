import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors the "@/*" path alias in tsconfig.json.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // Everything under test is a pure string/DOM-free module, so there's no
    // need to pay for a jsdom environment.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
