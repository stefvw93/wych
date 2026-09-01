---
title: Use with AI agents
description: The docs ship inside the npm package, so a coding agent reads them off disk.
order: 6
---

# Use with AI agents

Every page of this site ships inside the published package, as plain markdown, at `node_modules/@wych/react/docs`. Nothing discovers that path on its own. Point at it from your `AGENTS.md` or `CLAUDE.md`.

```md
## @wych/react

This project uses `@wych/react`, a TEA-style feature runtime for React built
on Effect. The docs are local, as markdown:

    node_modules/@wych/react/docs

Read `index.md` first. Then `reference/` for the API you are changing,
`how-to/` for a recipe, `explanation/` for why the model works this way.
Do not invent APIs: every export is listed under `reference/`.
```

## Check what is on disk

```sh
ls node_modules/@wych/react/docs
# => explanation  how-to  index.md  reference  tutorial

ls node_modules/@wych/react/docs/reference
# => actions.md  commands.md  devtools.md  features.md
#    lifecycle.md  runtime.md  tasks.md
```

The tarball ships `dist` and `docs`. The version on disk matches the version you installed, so an agent reading it cannot describe an API you do not have.

## Read them over HTTP

Two routes serve the same content over HTTP.

```sh
# One line per page, with links. Follows the llms.txt convention.
curl https://wych.dev/llms.txt

# Every page concatenated into one document.
curl https://wych.dev/llms-full.txt
```

## The layout

The tree follows [Diátaxis](https://diataxis.fr). The directory says what a page is for, which is the cheapest signal an agent can use to pick one.

```sh
docs/
  index.md          # the section map
  tutorial/         # lessons, numbered in reading order
  how-to/           # recipes for a task you already have
  reference/        # one page per API area
  explanation/      # why the model is shaped this way
```

Send an agent to `reference/` for a signature and `how-to/` for a working file set. [The model](/docs/explanation/the-model) is the one page worth reading before writing any feature.
