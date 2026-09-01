import path from "node:path";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.browser.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.{ts,tsx}"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      // Executes the docs snippets `scripts/docs-check.mjs --run` generates, so
      // every `// =>` result comment in the docs is asserted, in a real DOM.
      {
        resolve: { alias: { "@wych/react": path.resolve(import.meta.dirname, "src/index.ts") } },
        // One pre-bundle for every React entry, so `react-dom/server` and the
        // library share one React copy in the browser.
        optimizeDeps: {
          include: ["react", "react/jsx-runtime", "react-dom/client", "react-dom/server"],
        },
        test: {
          name: "docs",
          include: [".docs-check/**/run/*.docs.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
  pack: {
    dts: {
      tsgo: true,
    },
  },
  run: {
    tasks: {
      "test:types": {
        command: "tstyche",
        input: [{ auto: true }, "src/**/*.tst.{ts,tsx}", "tsconfig.json", "package.json"],
      },
      "docs:check": {
        command: "node scripts/docs-check.mjs --run",
        input: ["docs/**/*.md", "src/**/*.ts", "scripts/docs-check.mjs", "tsconfig.json"],
      },
    },
  },
});
