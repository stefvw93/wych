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
    // Inference first: a cast, a type argument or a type parameter the
    // compiler does not need is noise a reader has to prove harmless.
    rules: {
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/no-unnecessary-type-arguments": "error",
      "typescript/no-unnecessary-type-parameters": "error",
    },
    overrides: [
      {
        files: ["packages/website/**"],
        plugins: ["react", "nextjs"],
      },
      // A type test spells a default out when the default is what it asserts:
      // `toBe<Command<never, never>>` is the claim that `R` is `never`.
      {
        files: ["packages/react/src/__type-tests__/**"],
        rules: { "typescript/no-unnecessary-type-arguments": "off" },
      },
    ],
  },
  fmt: {},
});
