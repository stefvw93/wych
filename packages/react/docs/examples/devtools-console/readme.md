# devtools-console

## Overview

A plain counter mounted under `consoleDevtoolsLayer()`, active only in
development. `runtime.ts` installs it through the root layer, `counter.tsx`
and `main.tsx` are an unremarkable feature and mount. `sinks.ts` holds four
alternative sinks to swap in: `verbose`, `quiet`, `onlyCounter`, and `bridge`.

## Problem

A feature moved to a state you did not expect. In a `useReducer` app the way
to see the action and the state on both sides is a `console.log` inside the
reducer: production code edited for one debugging session, and edited again
to take it out. Mounts, prop changes and the commands a handler returned are
not visible at all that way.

## Solution

Devtools are a service installed through the root layer:

```ts fragment
const devtools = import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty;
export const { component } = createRuntime(Layer.mergeAll(app, devtools));
```

Because it is a `Layer`, swapping the sink out never touches the feature or
the mount code. `sinks.ts` shows the alternatives: `verbose` spells out every
`createConsoleDevtools` option, `quiet` drops transitions that did not change
state with `skipUnchanged`, `onlyCounter` filters by component name, and
`bridge` forwards each `DevtoolsEvent` to another window with
`window.postMessage`, built directly from `devtoolsLayer` instead of the
console helper.

## How It Works

`counter.tsx` is an ordinary `define`/`create` feature with no devtools
import; it does not need to know devtools exist. `runtime.ts` is the only
file that wires the sink in, and `main.tsx` just mounts `Counter` and prints
instructions to open the console. Press the button and each transition
prints there.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev`.
Inside this monorepo, run `vp -C packages/react/docs/examples/devtools-console dev`
from the repo root, and `vp -C packages/react/docs/examples/devtools-console run test:types`
to type-check.

## When to Use

Follow this alongside `../../how-to/install-devtools.md` to add
transition logging to a feature, or to pick a sink (verbose, filtered, or a
custom bridge) for local development.
