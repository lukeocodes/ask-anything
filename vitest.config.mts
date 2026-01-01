import { defineConfig } from "vitest/config";

/**
 * One root run over the whole workspace. Tests sit next to their sources as
 * `*.test.ts`. `@ask/*` imports resolve through the workspace symlinks (each
 * package's `exports` points at its `src/`), so no aliases are needed.
 */
export default defineConfig({
  test: {
    include: ["apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/.opencode/**", "**/.agents/**", "**/.overseer/**"],
    environment: "node",
    passWithNoTests: true,
  },
});
