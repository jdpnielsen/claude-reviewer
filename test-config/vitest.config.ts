import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  root: path.resolve(__dirname, ".."),
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test-config/vitest.setup.ts"],
    exclude: [...configDefaults.exclude, ".next/**", "tests/e2e/**", ".claude/worktrees/**"],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "app/**/*.{ts,tsx}"],
      exclude: ["**/*.d.ts", "**/node_modules/**"],
    },
  },
});
