import path from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["features/**/*.test.{ts,tsx}", "lib/**/*.test.{ts,tsx}"],
  },
});
