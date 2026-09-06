---
title: Subscribe to a stream
description: Start a long-lived source on Mounted, rebook it on PropsChanged, cancel it on Unmounted.
order: 2
example: presence-stream
---

# Subscribe to a stream

A websocket, a presence feed, an event source: one source that outlives every render and dispatches an action per element. In a component this is a `useEffect` with a cleanup function and a dependency array. The handler that folds each event into state lives in a closure the test cannot reach.

In a feature the subscription is a command. Book it under a name on `Mounted`, rebook it on `PropsChanged`, cancel the name on `Unmounted`. The reducer folds every event, and `feature.run` tests the whole thing with a finite stream.

## Declare the source

The source is a service, so a test can swap it for a finite stream.

```tsx
import { Action, Command, define } from "@wych/react";
import { Context, Effect, Layer, Schema, Stream } from "effect";

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

## Wrap the stream in a keyed command

`Stream.runForEach(source, dispatch)` inside `Command.effect` is the whole subscription. `Command.keyed` gives the fiber a name that `Command.cancel` can reach.

```tsx continue
const subscribe = (roomId: string) =>
  Command.keyed(
    "presence",
    Command.effect<typeof Changed.Type, PresenceApi>((dispatch) =>
      Effect.gen(function* () {
        const api = yield* PresenceApi;
        yield* Stream.runForEach(api.events(roomId), (event) => dispatch(Changed.make(event)));
      }),
    ),
  );
```

Written outside a reducer handler, `Command.effect` loses the contextual action type and infers `never`. The type argument restores it. The [commands reference](/docs/reference/commands) covers the rest of that gotcha.

## Start, rebook and cancel

Three lifecycle handlers own the subscription. `Command.restart` is `cancel` then `keyed` under one name, which is what a changed `roomId` needs.

```tsx continue
const presence = Presence.create({
  initialState: () => ({ online: [] }),
  reducer: {
    Changed: ({ userId, online }, { state }) => ({
      ...state,
      online: online ? [...state.online, userId] : state.online.filter((id) => id !== userId),
    }),
    Mounted: (_payload, { state, props }) => [state, subscribe(props.roomId)],
    PropsChanged: ({ previous }, { state, props }) =>
      previous.roomId === props.roomId
        ? state
        : [{ ...state, online: [] }, Command.restart("presence", subscribe(props.roomId))],
    Unmounted: (_payload, { state }) => [state, Command.cancel("presence")],
  },
  render: ({ state }) => (
    <ul>
      {state.online.map((userId) => (
        <li key={userId}>{userId}</li>
      ))}
    </ul>
  ),
});
```

`PropsChanged` fires for any prop, so the handler compares `previous.roomId` with `props.roomId` and returns `state` when the room is the same. Resetting `online` to `[]` on a room change is the second decision: the new room's stream reports its own members, and the old list must not linger until they arrive.

`Unmounted` runs with the services still alive, and its returned state is discarded. Only the command survives, which is why the handler returns `state` unchanged.

### Why `Unmounted` cancels when unmount already sweeps

Under a mount, teardown interrupts every fiber the feature has in flight before it runs the `Unmounted` command. React unmount does this, and so does `stop()` on a store you drive by hand. The `cancel` in the handler then finds nothing to cancel.

`feature.run` sweeps nothing. It resolves only when nothing is queued and nothing is in flight, so a source that never completes keeps `run` open forever. Seeding `Unmounted` last ends the subscription because the handler says so.

```tsx continue
const endless = Layer.succeed(PresenceApi)({ events: () => Stream.never });

const stopped = await Effect.runPromise(
  presence.run([{ _tag: "Mounted" }, { _tag: "Unmounted" }], {
    props: { roomId: "general" },
    hooks: {},
    layer: endless,
  }),
);
console.log(stopped.emitted);
// => []
```

Without the `Unmounted` handler this `run` never resolves. The handler is the feature's own statement of how it stops. It holds for every consumer: a React mount, a store driven by hand, `run`, and `reduce`, where the teardown is a `Cancel` command you can read as data. The [lifecycle reference](/docs/reference/lifecycle) shows that read.

## Test it with a finite stream

`feature.run` resolves once nothing is queued and nothing is in flight. A finite stream completes on its own, so the test needs no `Unmounted`.

```tsx continue
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
// => result.state: { online: ["ada", "grace"] }
// => result.emitted: [
//      { _tag: "Changed", userId: "ada", online: true },
//      { _tag: "Changed", userId: "grace", online: true },
//    ]
```

Seeded actions are folded but never appear in `emitted`. Everything a command dispatched does appear there, so `emitted` is the stream as the reducer saw it.

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

One group name per mount. Two `<Room>` elements are two mounts with two separate books, so `"presence"` in one never reaches the other.
