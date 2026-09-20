import path from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["features/**/*.test.{ts,tsx}", "lib/**/*.test.{ts,tsx}"],
  },
  run: {
    tasks: {
      // The site imports `@wych/react` from its `dist`.
      test: { command: "vp test", dependsOn: ["@wych/react#build"], cache: false },
    },
  },
});
