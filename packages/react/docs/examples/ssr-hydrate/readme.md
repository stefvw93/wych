# ssr-hydrate

## Overview

A counter rendered with `renderToString` to stand in for a server, then
hydrated in the browser with `hydrateRoot`. `main.tsx` logs that nothing
folds on the server, shows a bad prop throwing during that render, then logs
the counter's fold and command count once hydration completes.

## Problem

A component whose state lives in `useEffect` paints empty on the server and
fills in after hydration, so the server render is wasted. State the effect
derives from `window` or `Date.now()` makes the client's first render
disagree with the HTML, and React reports "Hydration failed because the
server rendered text didn't match the client" and regenerates the tree. A
bad prop that reaches the server render has to fail there, in the request,
where the log is.

## Solution

`counter.tsx` tracks how many times `Mounted` folded and how many commands
ran with two module-level counters, exposed by `counts()`. `renderToString`
renders the feature's initial state with no reducer fold and no command
execution:

```tsx fragment
const html = renderToString(<Counter start={5} />);
console.log("after renderToString", counts());
// => [0, 0]
```

A bad `start` prop, cast past the type checker, throws a `TypeError` from
schema validation during that same server render. Only after `hydrateRoot`
runs on the client does `Mounted` fold and its command execute, moving the
counters to `[1, 1]`.

## How It Works

`counter.tsx` exports `Provider` from `createRuntime`, showing that wrapping
the tree in `Provider` changes nothing about what folds during a server
render. `main.tsx` copies the server HTML into the DOM with `innerHTML`
before calling `hydrateRoot`, mirroring what a real server response would
leave for the client to attach to.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev`.
Inside this monorepo, run `vp -C packages/react/docs/examples/ssr-hydrate dev`
from the repo root, and `vp -C packages/react/docs/examples/ssr-hydrate run test:types`
to type-check.

## When to Use

Follow this alongside `../../how-to/render-on-the-server.md` when a feature
must render on the server and hydrate on the client without mismatched
markup or effects firing twice.
