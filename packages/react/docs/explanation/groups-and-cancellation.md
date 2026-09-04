---
title: Groups and cancellation
description: How a later action reaches work an earlier one started, and why the namespace is flat.
order: 4
---

# Groups and cancellation

A dashboard polls a metric every few seconds. In React the loop lives in a
`useEffect`, its cleanup clears the interval, and that is the only handle
anyone has. Pausing means a `paused` state that the effect depends on, so the
effect re-runs. "Refresh now" means a second effect or a ref to the
interval. The cleanup cancels the previous render's work and nothing else.

Wych gives every forked fiber a name, and any handler can cancel that name.

```ts
import { Action, Command, define, Next, summarizeCommand, Task } from "@wych/react";
import { Context, Effect, Layer, Schema } from "effect";

class Metrics extends Context.Service<Metrics, { readonly sample: Effect.Effect<number> }>()(
  "Metrics",
) {}

const Sampled = Action("Sampled", { value: Schema.Number });
const Paused = Action("Paused", {});
const Resumed = Action("Resumed", {});
const RefreshedNow = Action("RefreshedNow", {});

const Dashboard = define({
  props: Schema.Struct({ intervalMs: Schema.Number }),
  state: Schema.Struct({ latest: Schema.Number, paused: Schema.Boolean }),
  action: Action.of([Sampled, Paused, Resumed, RefreshedNow]),
});

const poll = (intervalMs: number) =>
  Command.keyed(
    "poll",
    Command.effect<typeof Sampled.Type, Metrics>((dispatch) =>
      Effect.forever(
        Effect.flatMap(Metrics, (metrics) => metrics.sample).pipe(
          Effect.flatMap((value) => dispatch(Sampled.make({ value }))),
          Effect.andThen(Effect.sleep(intervalMs)),
        ),
      ),
    ),
  );
```

The book is a flat map from name to fibers, one per mount. A `Group` is a
string, not a `{ tag, key }` pair, so a name means one thing per mount and
two handlers can share it on purpose.

## The booking address is `key ?? tag`

An unkeyed command books under the tag of the action that issued it.
`Command.keyed(name, command)` sets the whole address instead, and the
outermost `keyed` wins.

```ts continue
const dashboard = Dashboard.create({
  initialState: () => ({ latest: 0, paused: false }),
  reducer: {
    Mounted: (_payload, { state, props }) => [state, poll(props.intervalMs)],
    Sampled: ({ value }, { state }) => ({ ...state, latest: value }),
    Paused: (_payload, { state }) => [{ ...state, paused: true }, Command.cancel("poll")],
    Resumed: (_payload, { state, props }) => [
      { ...state, paused: false },
      Command.restart("poll", poll(props.intervalMs)),
    ],
    RefreshedNow: (_payload, { state }) => [
      state,
      Command.effect((dispatch) =>
        Effect.flatMap(Metrics, (metrics) => metrics.sample).pipe(
          Effect.flatMap((value) => dispatch(Sampled.make({ value }))),
        ),
      ),
    ],
    PropsChanged: ({ previous }, { state, props }) =>
      previous.intervalMs === props.intervalMs || state.paused
        ? state
        : [state, Command.restart("poll", poll(props.intervalMs))],
    Unmounted: (_payload, { state }) => [state, Command.cancel("poll")],
  },
  render: () => null,
});
```

Two addresses are in use. The loop books under `"poll"`, because it says so.
The one-off sample in `RefreshedNow` books under `"RefreshedNow"`, because
nothing named it.

`Paused` cancels work that `Mounted` started. That is the case no
combinator inside a single handler's effect can reach: the fiber to
interrupt was forked by a different fold, from a different handler. It is
why `cancel` is a command in its own right and why the book is per mount
rather than per handler.

```ts continue
const snapshot = {
  state: { latest: 0, paused: false },
  props: { intervalMs: 1000 },
  hooks: {},
};

console.log(summarizeCommand(Next.command(dashboard.reduce({ _tag: "Paused" }, snapshot))!));
// => { _tag: "Cancel", target: "poll" }
```

The cancel is the reason `run` resolves at all for this feature. `poll` is
`Effect.forever`, so a fold that starts it and never cancels it never
finishes.

```ts continue
const metrics = Layer.succeed(Metrics)({ sample: Effect.succeed(42) });

const paused = await Effect.runPromise(
  dashboard.run([{ _tag: "Mounted" }, Paused.make({})], {
    props: { intervalMs: 1000 },
    hooks: {},
    layer: metrics,
  }),
);

console.log(paused.state.paused);
// => true
```

## Why a bare-tag cancel misses keyed work

`Command.cancel("RefreshedNow")` interrupts the fibers booked under that
name. Work forked under `keyed("poll")` is addressed by `"poll"` alone, so a
cancel naming the tag does not reach it.

```ts continue
const stopRefresh = Command.cancel("RefreshedNow");
// => reaches the unkeyed one-off sample; the "poll" loop keeps running
```

The narrowing follows from the flat namespace. A key replaces the address,
so the tag is no longer part of it. Naming a group is therefore a decision
about who may cancel it: keep a command unkeyed and only its own tag
addresses it, or name it and every handler can.

## `restart` is sugar

Take-latest is a cancel followed by a keyed replacement, in that order.
`Resumed` and `PropsChanged` above both need it. `Command.restart`
constructs exactly that pair.

```ts continue
console.log(summarizeCommand(Command.restart("poll", Command.none)));
// => { _tag: "Batch", commands: [{ _tag: "Cancel", target: "poll" }, { _tag: "Keyed", key: "poll", command: { _tag: "None" } }] }
```

No ADT variant, no interpreter branch, no new devtools summary. The event
stream shows the desugared batch, so what devtools report is what the
runtime ran. Writing the pair by hand stays legal, and gets the ordering
wrong when the cancel lands second.

## Why tasks book under `Task/${Name}`

A [task](/docs/reference/tasks) names its own group, prefixed, so it cannot
collide with an action tag in the same flat namespace. A feature with an
action tagged `Sample` and a task named `Sample` would otherwise interrupt
each other on every fold.

```ts continue
const loadHistory = Task("History", {
  success: Schema.Array(Schema.Number),
  onError: Task.message,
});

console.log(summarizeCommand(loadHistory.cancel));
// => { _tag: "Cancel", target: "Task/History" }
```

Cancelling writes no state. A task left `Pending` after a cancel renders a
permanently disabled button, so the handler clears the field in the same
return: `[{ ...state, history: Task.idle }, loadHistory.cancel]`.

## What `batch` is for

`Command.batch` interprets its members in order, under one context. The
order is the point: a cancel has to run before the fiber replacing it is
registered, and nothing inside that new fiber can interrupt its predecessor.

```ts continue
const replace = Command.batch(Command.cancel("poll"), poll(500));
```

Composing two effects is a different job, and `Effect.all` inside one leaf
does it. That keeps both in one fiber, under one address, with one
interruption point.

```ts continue
const twoSamples = Command.effect<typeof Sampled.Type, Metrics>((dispatch) =>
  Effect.flatMap(Metrics, (metrics) => Effect.all([metrics.sample, metrics.sample])).pipe(
    Effect.flatMap(([first, second]) => dispatch(Sampled.make({ value: (first + second) / 2 }))),
  ),
);
```

## Teardown

Groups are per mount, so two dashboards on one page never interrupt each
other. On unmount the runtime sweeps every group first, then interprets the
`Unmounted` command with the feature's services still alive, then closes
the scope. Flush-on-exit work therefore belongs in the `Unmounted` handler,
because anything still in flight is already gone by the time it runs.

A `Cancel` waits for the interrupted fibers' finalizers before the next
command is processed. That wait is what lets a `batch` put a cancel ahead of
its replacement, and it means a finalizer that hangs stalls that mount's
command loop. Teardown is bounded at five seconds and reports an abandoned
teardown as a defect; nothing bounds a hung finalizer mid-mount today. Keep
finalizers short.

Signatures are in [commands](/docs/reference/commands); the recipes are in
[debounce and take-latest](/docs/how-to/debounce-and-take-latest) and
[subscribe to a stream](/docs/how-to/subscribe-to-a-stream).
