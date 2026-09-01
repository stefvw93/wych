# cart-tests

## Overview

A shopping cart feature (`src/cart.ts`) tested with no React and no browser,
in `src/cart.test.ts`. It runs with `vitest run`, using `feature.reduce` for
single transitions, `feature.run` for sequences, and `createRecorder` to
inspect the devtools stream.

## Problem

Testing a reducer through mounted components means rendering with
`@testing-library/react`, clicking buttons, and waiting for effects to
settle, just to check that one action produces the right state. That is slow
and couples the test to the view layer.

## Solution

`cart.ts` defines `cart` like any other feature: `Added`, `Submitted`, a
`Charge` task, and an `Ordered` output. The test file never imports React.
`cart.reduce` folds one action against a hand-written state and props
snapshot:

```ts fragment
test("Added appends and issues no command", () => {
  const next = cart.reduce(Added.make({ id: "a", price: 10 }), {
    state: empty,
    props: {},
    hooks: {},
  });
  expect(Next.state(next).items).toEqual([{ id: "a", price: 10 }]);
  expect(Next.command(next)).toBeUndefined();
});
```

`cart.run` folds a sequence of actions through a real layer, resolving once
every command settles, and returns `state`, `emitted` actions, and
`outputs`. Swapping `Payments` between a `paid` layer and a `declined` layer
tests the resolved and rejected paths without touching the feature.

## How It Works

The last two tests build a runtime with `devtoolsLayer(recorder.sink)` from
`createRecorder`, giving `recorder.events` to assert against directly,
filtered by `_tag` for `"Transition"` events.

Run the tests standalone or in StackBlitz: `npm install`, then `npm test`.
Inside this monorepo, run `vp -C packages/react/docs/examples/cart-tests run test`
from the repo root, and `vp -C packages/react/docs/examples/cart-tests run test:types`
to type-check.

## When to Use

Follow this alongside `../../how-to/test-a-feature-without-react.md` to test
a reducer, a task's resolved and rejected paths, or an emitted output,
without mounting a component.
