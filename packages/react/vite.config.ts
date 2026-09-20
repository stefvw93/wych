import path from "node:path";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

// A fresh instance per project: Vitest writes the nested project name onto
// the instance object, so a shared one collides across projects.
const chromium = () => ({ browser: "chromium" as const });
const browser = { enabled: true, headless: true, provider: playwright() };

/**
 * The `bench` and `stress` projects run one forked worker with `gc` exposed,
 * so a heap sample means one thing and `globalThis.gc()` is available to the
 * leak tests. Sequential: a stress test's timing is the assertion.
 */
const measured = {
  pool: "forks" as const,
  execArgv: ["--expose-gc"],
  fileParallelism: false,
  maxWorkers: 1,
  isolate: true,
};

/**
 * Bench mode swaps every project's `include` for its `benchmark.include`, whose
 * default glob would collect `*.bench.test.ts` under the browser projects too. Every
 * project that is not `bench` collects nothing in bench mode.
 */
const noBench = { benchmark: { include: [] } };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: [
            "src/**/*.browser.test.{ts,tsx}",
            "src/**/*.stress.test.{ts,tsx}",
            "src/**/*.bench.test.ts",
          ],
          ...noBench,
        },
      },
      {
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.{ts,tsx}"],
          exclude: ["src/**/*.stress.browser.test.{ts,tsx}"],
          ...noBench,
          browser: { ...browser, instances: [chromium()] },
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
          ...noBench,
          browser: { ...browser, instances: [chromium()] },
        },
      },
      // Performance and resilience, on demand: `vp run bench`, `vp run stress`.
      // Neither is part of `vpr -r test`; `lib.specs.md` "Performance and
      // resilience" says what they measure and where a finding lands.
      {
        test: {
          name: "bench",
          include: [],
          benchmark: { include: ["src/**/*.bench.test.ts"] },
          ...measured,
        },
      },
      {
        test: {
          name: "stress",
          include: ["src/**/*.stress.test.ts"],
          ...noBench,
          ...measured,
          testTimeout: 120_000,
          hookTimeout: 60_000,
          logHeapUsage: true,
          detectAsyncLeaks: true,
          sequence: { concurrent: false },
        },
      },
      {
        test: {
          name: "stress-browser",
          include: ["src/**/*.stress.browser.test.tsx"],
          ...noBench,
          testTimeout: 120_000,
          browser: {
            ...browser,
            // The pinned `test.fails` cases fail on purpose; no screenshot per run.
            screenshotFailures: false,
            // `window.gc()` for the leak tests, and an honest
            // `performance.memory.usedJSHeapSize`.
            provider: playwright({
              launchOptions: { args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"] },
            }),
            instances: [chromium()],
          },
        },
      },
    ],
  },
  pack: {
    platform: "neutral",
    dts: true,
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
      // Benchmarks against a local, gitignored baseline; `bench:baseline` writes
      // it. Numbers only compare on the machine that wrote them, so the file is
      // never committed. Without it `bench` still runs and only logs a read error.
      bench: {
        command: "vp test bench --project bench --compare bench/baseline.json",
        cache: false,
      },
      "bench:baseline": {
        command: "vp test bench --project bench --outputJson bench/baseline.json",
        cache: false,
      },
      stress: {
        command: "vp test --project stress --project stress-browser",
        cache: false,
      },
      "stress:node": { command: "vp test --project stress", cache: false },
      "stress:browser": { command: "vp test --project stress-browser", cache: false },
    },
  },
});
