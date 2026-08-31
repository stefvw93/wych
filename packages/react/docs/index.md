---
title: Overview
description: What @wych/react is and how its pieces fit together.
order: 1
---

# @wych/react

A TEA-style feature runtime for React, built on [Effect](https://effect.website).

A **feature** is declared with `define` and built with `create`: schema-typed
props and state, a tagged action vocabulary, an optional outbound output
vocabulary, and a reducer. The reducer is pure — it returns the next state and,
optionally, a `Command` describing work to do. The runtime interprets commands
as Effects.

Three consumers share one core:

- `feature.reduce(action, snapshot)` — the reducer as one pure function. No
  React, no Effect runtime.
- `feature.run(actions, options)` — folds a sequence of actions to quiescence
  and reports what was emitted. No React.
- `component(feature)` — the React binding.

All three share one command interpreter, so grouping and cancellation cannot
drift between them.

## Install

```sh
npm install @wych/react effect react react-dom
```

`effect`, `react` and `react-dom` are peer dependencies.

## Pages

- [Getting started](/docs/getting-started) — a first feature, end to end.
- [Features](/docs/features) — `define`, `create`, reducers, `Next`.
- [Commands](/docs/commands) — effects, grouping, cancellation.
- [Tasks](/docs/tasks) — async work as two actions and a four-case value.
- [Devtools](/docs/devtools) — observing transitions, commands and outputs.
