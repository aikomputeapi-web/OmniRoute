import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    pool: "threads",
    maxWorkers: 20,
    fileParallelism: true,
    maxConcurrency: 20,
    // `node:sqlite` is an experimental Node built-in used as a fallback DB
    // driver in audit.ts. Vite doesn't recognize it as an externalizable
    // builtin and errors with "Cannot bundle Node.js built-in node:sqlite";
    // externalize it so it's left as a runtime require.
    server: {
      deps: {
        external: ["node:sqlite", /^node:sqlite$/],
      },
    },
    // The MCP-audit DB checkpoint/close tests do real driver work and exceed
    // Vitest's 5s default when the suite saturates the runner; raise the ceiling.
    testTimeout: 30000,
    hookTimeout: 30000,
    include: [
      "open-sse/mcp-server/__tests__/**/*.test.ts",
      "open-sse/services/autoCombo/__tests__/**/*.test.ts",
      "open-sse/services/combo/__tests__/**/*.test.ts",
      "open-sse/services/__tests__/antigravity-quota-family.test.ts",
      "tests/unit/autoCombo/**/*.test.ts",
      "tests/unit/encryption.spec.ts",
      "src/shared/components/**/*.test.tsx",
      "src/shared/hooks/__tests__/**/*.test.tsx",
      "src/app/(dashboard)/**/__tests__/**/*.test.tsx",
    ],
    exclude: ["**/node_modules/**", "**/.git/**"],
    coverage: {
      reportsDirectory: "coverage",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
