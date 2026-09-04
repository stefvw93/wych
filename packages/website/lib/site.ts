/** Links and copy shared by the landing page and the docs shell. */
export const site = {
  name: "@wych/react",
  /** The headline: the category, then the hook. One sentence. */
  tagline: "Pure reducers for React, with Effect doing the work.",
  /** The subline: the mechanism. */
  subline:
    "Lifecycle, async and cancellation fold through one reducer. Test it without a renderer.",
  /** One-line description for metadata and package listings. */
  description: "A feature runtime for React: pure reducers, Effect commands, headless tests.",
  github: "https://github.com/stefvw93/wych",
  npm: "https://www.npmjs.com/package/@wych/react",
  install: "npm install @wych/react effect react react-dom",
} as const;
