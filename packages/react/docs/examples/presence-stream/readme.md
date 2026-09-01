# presence-stream

## Overview

A presence list fed by a long-lived stream. `presence-api.ts` declares a
`PresenceApi` service returning a `Stream`, `presence.tsx` subscribes on
`Mounted`, rebooks on `PropsChanged`, and cancels on `Unmounted`. `main.tsx`
supplies a fake ticking feed, switches rooms with plain React state, and
folds a finite stream to show `run` resolving once it drains.

## Problem

A subscription that outlives a single render needs to start on mount, restart
when its parameters change, and stop on unmount, without leaking a fiber or
double-subscribing. Doing this with `useEffect` means manually tracking
cleanup functions and dependency arrays.

## Solution

A long-lived source is `Stream.runForEach(source, dispatch)` inside
`Command.effect`, booked under a name so it can be cancelled and restarted:

```tsx fragment
PropsChanged: ({ previous }, { state, props }) =>
  previous.roomId === props.roomId
    ? state
    : [{ ...state, online: [] }, Command.restart("presence", subscribe(props.roomId))],
Unmounted: (_payload, { state }) => [state, Command.cancel("presence")],
```

`Mounted` starts the subscription once. `PropsChanged` compares the previous
and current `roomId` and only restarts the fiber when it actually changed.
`Unmounted` cancels it. All three are lifecycle tags handled the same way any
other action is handled, in the pure reducer.

## How It Works

`main.tsx` builds a fake feed with `Stream.tick("1 second")` that cycles
three people per room online and offline, and a room switcher that holds
`roomId` in `useState`. Changing rooms updates the `roomId` prop passed to
`<Room />`, which the feature receives as `PropsChanged`. A second block
folds `presence` with `presence.run([{ _tag: "Mounted" }], ...)` against a
two-event finite stream and logs the state and emitted actions once the
stream completes.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev`.
Inside this monorepo, run `vp -C packages/react/docs/examples/presence-stream dev`
from the repo root, and `vp -C packages/react/docs/examples/presence-stream run test:types`
to type-check.

## When to Use

Follow this alongside `../../how-to/subscribe-to-a-stream.md` for any feature
that must track a live source, such as presence, notifications, or a socket
feed, tied to the feature's own lifecycle.
