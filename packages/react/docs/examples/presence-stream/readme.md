# presence-stream

## Overview

A presence list fed by a long-lived stream. `presence-api.ts` declares a
`PresenceApi` service returning a `Stream`, `presence.tsx` declares the feed
as a subscription keyed on `roomId`. `main.tsx` supplies a fake ticking feed,
switches rooms with plain React state, and folds a finite stream to show
`run` resolving with the endless one too.

## Problem

A presence feed outlives every render. In a component it is a `useEffect`
with a cleanup function and a dependency array on `roomId`. The handler
that folds each event into state is a closure inside that effect. A room
switch depends on React running the cleanup before the next subscribe. A
test has to mount the component to reach any of it, and a feed that never
completes gives the test nothing to wait for.

## Solution

A long-lived source is declared, not started by hand. The `subscriptions`
hook on `create` returns the set of sources the current snapshot wants, keyed
by string; the runtime starts a new key and stops a missing one:

```tsx fragment
subscriptions: ({ props }) => ({
  [`presence:${props.roomId}`]: Subscription.effect((dispatch) =>
    Effect.gen(function* () {
      const api = yield* PresenceApi;
      yield* Stream.runForEach(api.events(props.roomId), (event) => dispatch(Changed, event));
    }),
  ),
}),
```

The stream's element type is the action's payload, so `dispatch(Changed, event)`
needs no mapping. The key carries everything the effect depends on:
`` `presence:${props.roomId}` ``, not `presence`. A room switch changes the key, which stops the old room's
fiber and starts the new one. `PropsChanged` only resets `online` to `[]` on a
room change; no handler starts, rebooks or cancels the feed.

## How It Works

`main.tsx` builds a fake feed with `Stream.tick("1 second")` that cycles
three people per room online and offline, and a room switcher that holds
`roomId` in `useState`. Changing rooms updates the `roomId` prop passed to
`<Room />`, which changes the key `subscriptions` returns. A second block
folds `presence` with `presence.run([{ _tag: "Mounted" }], ...)` against a
two-event finite stream and logs the state, emitted actions and declared
subscription keys. A third block folds the same feature against an endless
`Stream.never` feed and shows `run` resolving anyway, since a subscription
holds nothing open.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev`.
Inside this monorepo, run `vp -C packages/react/docs/examples/presence-stream dev`
from the repo root, and `vp -C packages/react/docs/examples/presence-stream run test:types`
to type-check.

## When to Use

Follow this alongside `../../how-to/subscribe-to-a-stream.md` for any feature
that must track a live source, such as presence, notifications, or a socket
feed, tied to the feature's own lifecycle.
