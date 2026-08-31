---
title: Using with AI agents
description: The docs ship inside the npm package, so a coding agent can read them locally.
order: 7
---

# Using with AI agents

Every page on this site ships inside the published package, as plain markdown,
at `node_modules/@wych/react/docs`. There is no build step and nothing to fetch
— an agent working in a project that depends on `@wych/react` can read the docs
straight off disk.

Nothing discovers that path on its own. Point at it from your `AGENTS.md` or
`CLAUDE.md`:

```md
## @wych/react

This project uses `@wych/react`, a TEA-style feature runtime for React built on
Effect. Docs are local at `node_modules/@wych/react/docs` — read
`docs/index.md` first, then the page for the area you are changing.
```

## Over HTTP

Two routes serve the same content for agents that fetch rather than read:

- [`/llms.txt`](/llms.txt) — the index: one line per page, with links.
- [`/llms-full.txt`](/llms-full.txt) — every page concatenated, as one document.

Both follow the [llms.txt convention](https://llmstxt.org).
