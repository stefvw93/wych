# cart-tests

## Overview

A shopping cart feature (`src/cart.ts`) tested with no React and no browser,
in `src/cart.test.ts`. It runs with `vitest run`, using `feature.reduce` for
single transitions, `feature.run` for sequences, and `createRecorder` to
inspect the devtools stream.

## Problem

A cart's reducer lives behind a component, so its tests go through the
component: render with `@testing-library/react`, click, await the effect,
read the DOM. One claim about one transition pays for a renderer. A claim
about a race, such as a second submit superseding a charge in flight, is
reachable only through timing, and a failed payment needs a mocked fetch
wired into the module the component imports.

## Solution

`cart.ts` defines `cart` like any other feature: `actions` (`Added` and
`Submitted`, declared as one record), a `Charge` task bound to the `charge`
state field through the `tasks` slot, and an `Ordered` output. The test file
never imports React. `cart.reduce` folds one action
against a hand-written state and props snapshot:

```ts fragment
test("Added appends and issues no command", () => {
  const next = cart.reduce(actions.Added.make({ id: "a", price: 10 }), {
    state: empty,
    props: {},
    hooks: {},
  });
  expect(Next.state(next).items).toEqual([{ id: "a", price: 10 }]);
  expect(Next.command(next)).toBeUndefined();
});
```

`cart.run` folds a sequence of actions through a real layer, resolving once
every command settles, and returns `state`, `emitted` actions, `outputs`,
and `defects` (a dying command, recorded even after its feature recovers).
Swapping `Payments` between a `paid` layer and a `declined` layer tests the
resolved and rejected paths without touching the feature.

## How It Works

`tasks: { charge }` adds `charge` to the state, so `initialState` leaves it
out and a hand-built test state includes `charge: Task.idle`.
`tasks.charge.start(total)` writes `Pending` into the field and returns the
command beside it. `charge` declares no `failure`, so a declined card lands in
the field as the error's message, with no `ChargeRejected` handler. The
receipt is in the field before `ChargeResolved` runs, so that handler only
announces the order beside it. The last two tests
build a runtime with `devtoolsLayer(recorder.sink)` from `createRecorder`,
giving `recorder.events` to assert against directly, filtered by `_tag` for
`"Transition"` events.

Run the tests standalone or in StackBlitz: `npm install`, then `npm test`.
Inside this monorepo, run `vp -C packages/react/docs/examples/cart-tests run test`
from the repo root, and `vp -C packages/react/docs/examples/cart-tests run test:types`
to type-check.

## When to Use

Follow this alongside `../../how-to/test-a-feature-without-react.md` to test
a reducer, a task's resolved and rejected paths, or an emitted output,
without mounting a component.
