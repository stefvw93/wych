---
title: Subscribe to a stream
description: Start a long-lived source on Mounted, rebook it on PropsChanged, cancel it on Unmounted.
order: 2
---

# Subscribe to a stream

A websocket, a presence feed, an event source: one long-lived `Stream` that dispatches an action per element. Book it under a name on `Mounted` and cancel that name on `Unmounted`.

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

## Wrap the stream in a keyed command

`Stream.runForEach(source, dispatch)` inside `Command.effect` is the whole subscription. `Command.keyed` gives the fiber a name that `Command.cancel` can reach.

```tsx continue
const subscribe = (roomId: string) =>
  Command.keyed(
    "presence",
    Command.effect<typeof Changed.Type, PresenceApi>((dispatch) =>
      Effect.flatMap(PresenceApi, (api) =>
        Stream.runForEach(api.events(roomId), (event) => dispatch(Changed.make(event))),
      ),
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

`Unmounted` runs with the services still alive, and its returned state is discarded. Only the command survives, which is why the handler returns `state` unchanged.

React unmount interrupts the fiber anyway. The `Unmounted` handler is what makes the same feature stop cleanly under `feature.run` and under a manual teardown. See the [lifecycle reference](/docs/reference/lifecycle).

## Test it with a finite stream

`feature.run` resolves at quiescence. A finite stream reaches it; `Stream.never` does not.

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

Seeded actions are folded but never appear in `emitted`. Everything a command dispatched does appear there.

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
