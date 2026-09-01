---
title: Groups and cancellation
description: One flat namespace per mount, the booking address a command gets, and why restart is sugar.
order: 4
---

Every command a feature issues forks a fiber, and every fiber is booked under one name. The book is a flat map from name to fibers, per mount.

```ts
import { Action, Command, define, Next, Task } from "@wych/react";
import { Context, Effect, Schema, Stream } from "effect";

class Rooms extends Context.Service<
  Rooms,
  {
    readonly presence: (roomId: string) => Stream.Stream<string>;
    readonly history: (roomId: string) => Effect.Effect<ReadonlyArray<string>>;
    readonly notify: (who: string) => Effect.Effect<void>;
  }
>()("Rooms") {}

const loadHistory = Task("History", {
  success: Schema.Array(Schema.String),
  onError: Task.message,
  run: (roomId: string) => Effect.flatMap(Rooms, (rooms) => rooms.history(roomId)),
});

const Arrived = Action("Arrived", { who: Schema.String });
const Left = Action("Left", {});
const Refreshed = Action("Refreshed", {});

const Room = define({
  props: Schema.Struct({ roomId: Schema.String }),
  state: Schema.Struct({
    present: Schema.Array(Schema.String),
    history: Task.schema(Schema.Array(Schema.String)),
  }),
  action: Action.of([Arrived, Left, Refreshed, ...loadHistory.actions]),
});
```

A `Group` is a string. It is not a `{ tag, key }` pair, so a name means one thing per mount and two handlers can share it on purpose.

## The booking address is `key ?? tag`

An unkeyed command books under the tag of the action that issued it. `Command.keyed(name, command)` sets the whole address instead, and the outermost `keyed` wins.

```ts continue
const room = Room.create({
  initialState: () => ({ present: [], history: Task.idle }),
  reducer: {
    Mounted: (_payload, { state, props }) => [
      state,
      Command.keyed(
        "presence",
        Command.effect((dispatch) =>
          Effect.flatMap(Rooms, (rooms) =>
            Stream.runForEach(rooms.presence(props.roomId), (who) =>
              dispatch({ _tag: "Arrived" as const, who }),
            ),
          ),
        ),
      ),
    ],
    Arrived: ({ who }, { state }) => [
      { ...state, present: [...state.present, who] },
      Command.effect(() => Effect.flatMap(Rooms, (rooms) => rooms.notify(who))),
    ],
    Left: (_payload, { state }) => [state, Command.cancel("presence")],
    Refreshed: (_payload, { state, props }) =>
      Task.start(state, "history", loadHistory.run(props.roomId)),
    HistoryResolved: ({ value }, { state }) => ({ ...state, history: Task.resolved(value) }),
    HistoryRejected: ({ error }, { state }) => ({ ...state, history: Task.rejected(error) }),
  },
  render: () => null,
});
```

Three addresses are in use there. The subscription books under `"presence"`, because it says so. The notification books under `"Arrived"`, because nothing named it. The task books under `"Task/History"`.

`Left` cancels work that `Mounted` started. That is the case no combinator inside a single handler's effect can reach, and it is why `cancel` is a command in its own right.

```ts continue
const snapshot = {
  state: { present: [], history: Task.idle },
  props: { roomId: "r1" },
  hooks: {},
};

Next.command(room.reduce({ _tag: "Left" }, snapshot));
// => { _tag: "Cancel", target: "presence" }
```

## Why a bare-tag cancel misses keyed work

`Command.cancel("Arrived")` interrupts the fibers booked under that name. Work forked under `keyed("presence")` is addressed by `"presence"` alone, so a cancel naming the tag does not reach it.

```ts continue
const stopNotifications = Command.cancel("Arrived");
// => reaches the unkeyed `notify` fibers; the presence subscription keeps running
```

The narrowing follows from the flat namespace. A key replaces the address, so the tag is no longer part of it. Naming a group is therefore a decision about who may cancel it: keep a command unkeyed and its own tag addresses it, or name it and every handler can.

## `restart` is sugar

Take-latest is a cancel followed by a keyed replacement, in that order. `Command.restart` constructs exactly that pair.

```ts continue
Command.restart("presence", Command.none);
// => { _tag: "Batch",
//      commands: [{ _tag: "Cancel", target: "presence" },
//                 { _tag: "Keyed", key: "presence", command: { _tag: "None" } }] }
```

No ADT variant, no interpreter branch, and no new devtools summary. The event stream shows the desugared batch, so what devtools report is what the runtime ran. Writing the pair by hand stays legal, and gets the ordering wrong when the cancel lands second.

## Why tasks book under `Task/${Name}`

A [task](/docs/reference/tasks) names its own group, prefixed, so it cannot collide with an action tag in the same flat namespace.

```ts continue
loadHistory.cancel;
// => { _tag: "Cancel", target: "Task/History" }
```

A feature with an action tagged `History` and a task named `History` would otherwise interrupt each other on every fold. The prefix is the whole defence, and it keeps `cancel` addressable from any handler.

Cancelling writes no state. A task left `Pending` after a cancel renders a permanently disabled button, so the handler clears the field in the same return.

```ts continue
const cancelHistory = Room.reducer({
  Arrived: ({ who }, { state }) => ({ ...state, present: [...state.present, who] }),
  Left: (_payload, { state }) => [{ ...state, history: Task.idle }, loadHistory.cancel],
  Refreshed: (_payload, { state, props }) =>
    Task.start(state, "history", loadHistory.run(props.roomId)),
  HistoryResolved: ({ value }, { state }) => ({ ...state, history: Task.resolved(value) }),
  HistoryRejected: ({ error }, { state }) => ({ ...state, history: Task.rejected(error) }),
});
```

## What `batch` is for

`Command.batch` interprets its members in order, under one context. The order is the point: a cancel has to run before the fiber replacing it is registered, and nothing inside that new fiber can interrupt its predecessor.

```ts continue
const replace = Command.batch(
  Command.cancel("presence"),
  Command.keyed(
    "presence",
    Command.effect(() => Effect.sleep("1 second")),
  ),
);
```

Composing two effects is a different job, and `Effect.all` inside one leaf does it. That keeps both in one fiber, under one address, with one interruption point.

```ts continue
const together = Command.effect(() =>
  Effect.all([
    Effect.flatMap(Rooms, (rooms) => rooms.notify("ada")),
    Effect.flatMap(Rooms, (rooms) => rooms.history("r1")),
  ]),
);
```

Groups are per mount, so two mounts of one component never interrupt each other. Teardown sweeps every group before the `Unmounted` command runs, which is why flush-on-exit work belongs in that handler. Signatures are in [commands](/docs/reference/commands); the recipes are in [debounce and take-latest](/docs/how-to/debounce-and-take-latest).
