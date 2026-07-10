import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: path.resolve(__dirname, ".."),
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test-config/vitest.e2e.setup.ts"],
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 30000,
    // The suite shares one Next.js server + DB dir per file (bound to a fixed
    // port), so files must run one at a time rather than in parallel workers.
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
