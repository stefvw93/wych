# counter

## Overview

A single-file counter feature. It bumps its count by a `step` prop, emits a
`Reached` output once the count hits 10, and mounts as `<Counter />`. A second
block in `main.tsx` folds the same feature without React and logs the result.

## Problem

A React counter usually keeps its count in `useState` and fires a callback
prop when a threshold is crossed. That mixes state, side effects, and view
code in one component, and there is no way to test the counting logic without
rendering it.

## Solution

Wych separates the three concerns. `counter.tsx` declares `props`, `state`,
and an `action` vocabulary with `define`, then supplies `initialState`,
`reducer`, and `render` to `Feature.create`. The `Bumped` handler returns a
plain state, or a `[state, command]` tuple that emits `Reached` once
`count >= 10`:

```ts fragment
Bumped: (_payload, { state, props }) => {
  const count = state.count + props.step;
  return count >= 10 ? [{ count }, Command.output(Reached, { at: count })] : { count };
},
```

`Reached` is declared with `Action.output`, so it never enters the reducer.
It only leaves through the `onReached` prop that `main.tsx` wires up.

## How It Works

`createRuntime(Layer.empty)` builds the runtime and `component(counter, ...)`
turns the feature into `Counter`. `main.tsx` mounts it, then calls
`counter.run` with two `Bumped` actions and no React at all, logging the
folded state and the outputs it collected.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev`.
Inside this monorepo, run `vp -C packages/react/docs/examples/counter dev`
from the repo root, and `vp -C packages/react/docs/examples/counter run test:types`
to type-check.

## When to Use

Start here to see the shape of a Wych feature: `define`, `create`, `dispatch`,
and the action/output split, before adding async work or composition. See
`../../index.md` for the concepts this example backs.
