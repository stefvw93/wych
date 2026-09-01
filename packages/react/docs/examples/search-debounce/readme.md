# search-debounce

## Overview

Three search features side by side against a deliberately slow (500 ms) stub
API, so "Searching" stays visible: `searchFeature` debounces inside a command
with `Command.restart`, `taskSearch` takes the latest result with a `Task`,
and `everySearch` keeps every result with `mode: "every"`. `main.tsx` also
runs a fast comparison between "latest" and "every" and logs it.

## Problem

A search box must not fire a request on every keystroke, and a slow request
for an old query must not overwrite the result of a newer one. Concurrency
policy is often bolted onto a search hook as ad hoc timers and flags.

## Solution

Wych has no built-in debounce or policy option. Debounce is `Effect.sleep`
inside a command, cancelled and restarted by name:

```tsx fragment
Command.restart(
  "query",
  Command.effect((dispatch) =>
    Effect.sleep("300 millis").pipe(
      Effect.andThen(Effect.flatMap(SearchApi, (api) => api.hits(query))),
      Effect.flatMap((hits) => dispatch(Loaded.make({ hits }))),
    ),
  ),
),
```

Take-latest and take-every are both `Task` options. `taskSearch` uses the
default `mode: "latest"`, which books under `Command.restart` so a new
`Typed` cancels the fiber still resolving the old one. `everySearch` sets
`mode: "every"`, which books under `Command.keyed` and never interrupts.

## How It Works

`search-api.ts` declares `SearchApi` as a service with one `hits` method.
`main.tsx` supplies a layer where `hits` sleeps 500 ms, mounts
`DebouncedSearch` and `Search` under one runtime, then runs `taskSearch` and
`everySearch` against a faster 50 ms layer with two keystrokes
(`"a"`, `"ab"`), logging that `taskSearch` emits one `SearchResolved` for
`"ab!"` while `everySearch` emits both.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev`.
Inside this monorepo, run `vp -C packages/react/docs/examples/search-debounce dev`
from the repo root, and `vp -C packages/react/docs/examples/search-debounce run test:types`
to type-check.

## When to Use

Follow this alongside `../../how-to/debounce-and-take-latest.md` when a
feature needs to throttle, debounce, or choose between take-latest and
take-every for concurrent async work.
