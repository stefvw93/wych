# search-debounce

## Overview

Four search features side by side against a deliberately slow (500 ms) stub
API, so "Searching" stays visible: `searchFeature` debounces inside a command
with `Command.restart`, `taskSearch` takes the latest result with a `Task`,
`everySearch` keeps every result with `mode: "every"`, and `pagedSearch` loads
the next page through a lazy command that reads the state the handler built.
`src/search.test.ts` proves the "latest" and "every" comparison and the lazy
page request as vitest tests, headless, without mounting any feature.

## Problem

A search box in React fires a request on every keystroke. The `useEffect` that
fetches grows a timer, the timer grows a cleanup, and a ref drops the response
from the keystroke before. The two rules (wait for the typing to pause, keep
only the newest result) live in a hook, and neither runs without a DOM.

## Solution

Both rules live in the reducer, as a command value. Debounce is `Effect.sleep`
inside the command, cancelled and restarted by name:

```tsx fragment
Command.restart(
  "query",
  Command.effect((dispatch) =>
    Effect.gen(function* () {
      yield* Effect.sleep("300 millis");
      const api = yield* SearchApi;
      const hits = yield* api.hits(query);
      yield* dispatch(Loaded.make({ hits }));
    }),
  ),
),
```

Take-latest and take-every are both `Task` options. `taskSearch` uses the
default `mode: "latest"`, which books under `Command.restart` so a new
`Typed` cancels the fiber still resolving the old one. `everySearch` sets
`mode: "every"`, which books under `Command.keyed` and never interrupts.

`pagedSearch` writes `page + 1` and needs that number in the request.
`Task.start` takes a thunk, which receives the state the handler built with
`Pending` written, so the request reads the page from that state:

```tsx fragment
MoreClicked: (_payload, { state }) =>
  Task.start({ ...state, page: state.page + 1 }, "results", (next) => searchPage.run(next)),
```

## How It Works

`search-api.ts` declares `SearchApi` as a service with one `hits` method
that takes a query and an optional page. `main.tsx` supplies a layer where
`hits` sleeps 500 ms and mounts `DebouncedSearch`, `Search` and `PagedSearch`
under one runtime. `src/search.test.ts` runs
against a faster 50 ms layer: one `reduce` test checks the `Pending` write
and command for a single keystroke, and two `run` tests fold two keystrokes
(`"a"`, `"ab"`) through `taskSearch` and `everySearch` until nothing is left
running, showing that `taskSearch` emits one `SearchResolved` for `"ab!"` (the
`"a"` fiber is interrupted) while `everySearch` emits both, in order. A fourth
test folds a keystroke and a "more" click through `pagedSearch`: the click
interrupts page 1 and the one result carries page 2.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev` (the
app) or `npm test` (the comparison). Inside this monorepo, run
`vp -C packages/react/docs/examples/search-debounce dev` from the repo root,
`vp -C packages/react/docs/examples/search-debounce run test` to run the
tests, and `vp -C packages/react/docs/examples/search-debounce run test:types`
to type-check.

## When to Use

Follow this alongside `../../how-to/debounce-and-take-latest.md` when a
feature needs to debounce a request, choose between take-latest and
take-every for concurrent async work, or issue a request that reads a value
the handler computed into the next state.
