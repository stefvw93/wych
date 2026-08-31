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
    },
  },
});
