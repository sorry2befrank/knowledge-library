import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "cli/*/src/**/*.test.ts"],
    pool: "forks",
    execArgv: ["--no-warnings=ExperimentalWarning"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ["default"],
    passWithNoTests: false,
  },
});
