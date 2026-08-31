import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: "./packages/react",
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ["packages/website/**"],
        plugins: ["react", "nextjs"],
      },
    ],
  },
  fmt: {},
});
