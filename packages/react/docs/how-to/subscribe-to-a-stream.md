---
title: Subscribe to a stream
description: Declare a long-lived source as a subscription, keyed on what it depends on, with no lifecycle handlers to manage it by hand.
order: 2
example: presence-stream
---

# Subscribe to a stream

A websocket, a presence feed, an event source: one source that outlives every render and dispatches an action per element. In a component this is a `useEffect` with a cleanup function and a dependency array. The handler that folds each event into state lives in a closure the test cannot reach.

In a feature the subscription is declared. The `subscriptions` hook on `create` returns the set of sources the current snapshot wants, keyed by string. The runtime starts a new key, stops a missing one, and leaves the rest alone. A room switch is a key change, and the runtime does the rest.

## Declare the source

The source is a service, so a test can swap it for a finite stream.

```tsx
import { Action, Subscription, define } from "@wych/react";
import { Context, Effect, Schema, Stream } from "effect";

class PresenceApi extends Context.Service<
  PresenceApi,
  {
    readonly events: (
      roomId: string,
    ) => Stream.Stream<{ readonly userId: string; readonly online: boolean }>;
  }
>()("PresenceApi") {}

const Changed = Action("Changed", { userId: Schema.String, online: Schema.Boolean });

const Presence = define({
  props: Schema.Struct({ roomId: Schema.String }),
  state: Schema.Struct({ online: Schema.Array(Schema.String) }),
  action: Action.of([Changed]),
});
```

One decision here: the stream's element type is the action's payload, so `Changed.make(event)` needs no mapping. Map inside the service when the wire format differs.

## Declare the subscription

`Subscription.effect((dispatch) => Effect<...>)` is the one constructor. `Stream.runForEach(source, dispatch)` inside it is the whole subscription, the same leaf `Command.effect` uses.

```tsx continue
const presence = Presence.create({
  initialState: () => ({ online: [] }),
  reducer: {
    Changed: ({ userId, online }, { state }) => ({
      ...state,
      online: online ? [...state.online, userId] : state.online.filter((id) => id !== userId),
    }),
    PropsChanged: ({ previous }, { state, props }) =>
      previous.roomId === props.roomId ? state : { ...state, online: [] },
  },
  subscriptions: ({ props }) => ({
    [`presence:${props.roomId}`]: Subscription.effect((dispatch) =>
      Effect.gen(function* () {
        const api = yield* PresenceApi;
        yield* Stream.runForEach(api.events(props.roomId), (event) =>
          dispatch(Changed.make(event)),
        );
      }),
    ),
  }),
  render: ({ state }) => (
    <ul>
      {state.online.map((userId) => (
        <li key={userId}>{userId}</li>
      ))}
    </ul>
  ),
});
```

The key carries everything the effect depends on. `` `presence:${props.roomId}` `` is the identity: two folds that return the same key keep the same fiber, closure and all, even if a room switch would have built a different closure. A key of plain `"presence"` would never change on a room switch, so the runtime would keep the old room's fiber. Put every dependency in the key.

`Mounted` and `Unmounted` are gone from this feature. `PropsChanged` still resets `online` to `[]` on a room change, since the new room's feed reports its own members and the old list must not linger until they arrive. It returns `state` unchanged for any other prop change.

`dispatch` is typed by the feature's vocabulary and `PresenceApi` is read off the effect, with no type argument: the hook's slot supplies the contextual type, the same rule `Command.effect` follows in a handler. A `Subscription.effect` written outside the hook needs the type argument. See [Subscriptions](/docs/reference/subscriptions#contextual-typing) for the rule.

## Test it with a finite stream

`feature.run` resolves at command quiescence: nothing queued, no command fiber in flight. Subscription fibers count for nothing, so a finite stream needs no `Unmounted` to make `run` resolve.

```tsx continue
import { Layer } from "effect";

const twoEvents = Layer.succeed(PresenceApi)({
  events: () =>
    Stream.fromArray([
      { userId: "ada", online: true },
      { userId: "grace", online: true },
    ]),
});

const result = await Effect.runPromise(
  presence.run([{ _tag: "Mounted" }], {
    props: { roomId: "general" },
    hooks: {},
    layer: twoEvents,
  }),
);
console.log(result.state);
// => { online: ["ada", "grace"] }
console.log(result.emitted);
// => [
//      { _tag: "Changed", userId: "ada", online: true },
//      { _tag: "Changed", userId: "grace", online: true },
//    ]
console.log(result.subscriptions);
// => ["presence:general"]
```

Seeded actions are folded but never appear in `emitted`. `subscriptions` lists the keys declared when `run` resolved, in record order.

An endless source resolves too, because a subscription never holds `run` open.

```tsx continue
const endless = Layer.succeed(PresenceApi)({ events: () => Stream.never });

const stillResolves = await Effect.runPromise(
  presence.run([{ _tag: "Mounted" }], {
    props: { roomId: "general" },
    hooks: {},
    layer: endless,
  }),
);
console.log(stillResolves.subscriptions);
// => ["presence:general"]
```

`run` interrupts every subscription fiber before it returns, finalizers awaited. A command written with `Command.effect(() => Effect.never)` still keeps `run` open: that is what a command is. A long-lived source belongs in `subscriptions` instead.

## Mount it

```tsx continue
import { createRuntime } from "@wych/react";
import { createRoot } from "react-dom/client";

const live = Layer.succeed(PresenceApi)({
  events: () => Stream.fromArray([{ userId: "ada", online: true }]),
});

const { component } = createRuntime(live);

const Room = component(presence, { name: "Presence" });

createRoot(document.getElementById("root")!).render(<Room roomId="general" />);
```

A room switch changes the key returned by `subscriptions`. The runtime stops the old room's fiber and starts the new one when the render that carries the new prop commits, before the browser paints. No lifecycle handler is involved. A render React abandons, such as a transition that suspends, starts nothing.
