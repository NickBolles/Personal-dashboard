import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
      "server-only": path.resolve(import.meta.dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "e2e/**", ".next/**"],
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    pool: "forks",
    coverage: { provider: "v8", include: ["server/**", "integrations/**", "lib/**"] },
  },
});
