---
title: Subscriptions
description: Subscription.effect, the Subscriptions record, the subscriptions hook, the key rule, the diff, and how Feature.run treats a long-lived source.
order: 5
---

# Subscriptions

A subscription is a long-lived source, declared rather than issued. The
`subscriptions` hook on `create` returns the set a snapshot wants; the
runtime diffs that set by key against what is running, starting new keys and
stopping missing ones.

Every snippet on this page builds on one feature: a presence feed that
reports who is online in a room.

```tsx
import { Action, Command, Subscription, define } from "@wych/react";
import type { Subscriptions } from "@wych/react";
import { Context, Effect, Layer, Schedule, Schema, Stream } from "effect";

class PresenceApi extends Context.Service<
  PresenceApi,
  { readonly events: (roomId: string) => Stream.Stream<{ readonly userId: string }> }
>()("PresenceApi") {}

const Changed = Action("Changed", { userId: Schema.String });

const Presence = define({
  props: Schema.Struct({ roomId: Schema.String }),
  state: Schema.Struct({ online: Schema.Array(Schema.String) }),
  actions: Changed,
});
```

## `Subscription.effect`

```ts fragment
Subscription.effect<A = never, R = never>(
  effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>,
): Subscription<A, R>

Subscription.effect<const S extends MemberSource<Channel>, R = never>(
  source: S,
  effect: (dispatch: Dispatcher<MembersOf<S>>) => Effect.Effect<unknown, never, R>,
): Subscription<MembersOf<S>, R>
```

The one constructor. `effect` is the same leaf `Command.effect` takes:
`dispatch` emits actions and outputs, as a message schema and its payload or
as a built message (see
[`Dispatcher`](/docs/reference/commands#dispatcher-and-dispatch)), and the
effect's error channel is `never`, so the effect handles its own failures
before it dies (see [Failure](#failure)). The second overload takes a
`source` first, the same value a `define` slot takes, and types `dispatch`
from it; see [Contextual typing](#contextual-typing).

```ts continue
const presence = Presence.create({
  initialState: () => ({ online: [] }),
  reducer: {
    Changed: ({ userId }, { draft }) => {
      draft.online.push(userId);
      return draft;
    },
  },
  subscriptions: ({ props }) => ({
    [`presence:${props.roomId}`]: Subscription.effect((dispatch) =>
      Effect.gen(function* () {
        const api = yield* PresenceApi;
        yield* Stream.runForEach(api.events(props.roomId), (event) => dispatch(Changed, event));
      }),
    ),
  }),
  render: () => null,
});
```

A `Stream` is `Stream.runForEach`; a listener is `Effect.acquireRelease` then
`Effect.never`; reconnect is `Effect.retry` inside the effect. Nothing but the
leaf is new.

## `Subscriptions`

```ts fragment
type Subscriptions<A, R = never> = Readonly<Record<string, Subscription<A, R> | undefined>>;
```

The hook's return type: own keys only, in the order the runtime starts them.
A key whose value is `undefined` is not declared, so a conditional source has
two equivalent spellings.

```ts continue
const declareConditionally = Presence.subscriptions(({ props }) => ({
  [`presence:${props.roomId}`]: props.roomId
    ? Subscription.effect((dispatch) =>
        Effect.gen(function* () {
          const api = yield* PresenceApi;
          yield* Stream.runForEach(api.events(props.roomId), (event) => dispatch(Changed, event));
        }),
      )
    : undefined,
}));

const declaredKeys = (subscriptions: Subscriptions<unknown, unknown>) =>
  Object.keys(subscriptions).filter((key) => subscriptions[key] !== undefined);

console.log(
  declaredKeys(declareConditionally({ state: { online: [] }, props: { roomId: "" }, hooks: {} })),
);
// => []
console.log(
  declaredKeys(
    declareConditionally({ state: { online: [] }, props: { roomId: "general" }, hooks: {} }),
  ),
);
// => ["presence:general"]
```

Plain `Object.keys` still lists a key whose value is `undefined`, so the
runtime (and this helper) filters those out before treating a key as
declared.

## The `subscriptions` hook

```ts fragment
Feature.create({
  initialState,
  reducer,
  render,
  subscriptions?: (snapshot: Snapshot<Props, State, H>) => Subscriptions<Emit<A, O>, R>,
});

Definition.subscriptions(fn); // identity typer, beside reducer and render
```

`subscriptions` is optional, beside `reducer` and `render` on `create`, not a
reducer key: it does not return a `Next`, so it cannot live under an action
tag. Absent, the store never evaluates a diff and nothing is paid.
`Definition.subscriptions` supplies the same contextual type `reducer` does,
so the hook can live in its own file.

```ts continue
const subscriptions = Presence.subscriptions(({ props }) => ({
  [`presence:${props.roomId}`]: Subscription.effect((dispatch) =>
    Effect.gen(function* () {
      const api = yield* PresenceApi;
      yield* Stream.runForEach(api.events(props.roomId), (event) => dispatch(Changed, event));
    }),
  ),
}));
```

## The key rule

The record key is the whole identity. Two `Subscription` values under one key
across two folds are the same subscription, closure and all, so anything the
effect depends on belongs in the key.

```ts continue
const snapshotFor = (roomId: string) => ({
  state: { online: [] },
  props: { roomId },
  hooks: {},
});

console.log(Object.keys(presence.subscriptions(snapshotFor("general"))));
// => ["presence:general"]
console.log(Object.keys(presence.subscriptions(snapshotFor("random"))));
// => ["presence:random"]
```

A key of plain `"presence"` for both rooms would return the same key on a
room change, so the runtime would see nothing to stop or start and would keep
the old room's fiber, closure and all. The runtime cannot see inside a
closure, so the key has to say what the closure captured.

## The diff

The hook runs after every fold that moves state, props or hooks, once per
drain rather than once per action. The result is a key diff against what is
running: `declared ∖ running` starts, `running ∖ declared` stops, the
intersection is untouched. Stops are interpreted before starts.

```ts continue
const before = new Set(Object.keys(presence.subscriptions(snapshotFor("general"))));
const after = new Set(Object.keys(presence.subscriptions(snapshotFor("random"))));

console.log([...before].filter((key) => !after.has(key)));
// => ["presence:general"]
console.log([...after].filter((key) => !before.has(key)));
// => ["presence:random"]
```

A key whose fiber completed or died stays in the running set as done or died.
The diff treats a still-declared done or died key as unchanged: it does not
restart on its own. It restarts only when its key leaves the declared set and
returns, which is what makes a finite `Stream.fromArray` stub legal in a test.

## `Feature.subscriptions`

```ts fragment
feature.subscriptions(snapshot: Snapshot<Props, State, H>): Subscriptions<Action | Output, R>
```

The hook as one pure function, beside `reduce`. No React, no Effect runtime:
"which keys does this state want" is a test with no mount.

```ts continue
console.log(Object.keys(presence.subscriptions(snapshotFor("general"))));
// => ["presence:general"]
```

A feature with no `subscriptions` hook returns `{}` for every snapshot.

## `Feature.run` and subscriptions

`run` resolves at command quiescence: nothing queued, no command fiber in
flight. A subscription fiber counts for nothing toward that, so an endless
source does not hold `run` open. A never-completing command does, because
that is what a command is.

```ts continue
const twoEvents = Layer.succeed(PresenceApi)({
  events: () => Stream.fromArray([{ userId: "ada" }, { userId: "grace" }]),
});

const finite = await Effect.runPromise(
  presence.run([{ _tag: "Mounted" }], {
    props: { roomId: "general" },
    hooks: {},
    layer: twoEvents,
  }),
);
console.log(finite.state);
// => { online: ["ada", "grace"] }
console.log(finite.subscriptions);
// => ["presence:general"]

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

`run` evaluates the hook after each reduced action, on the store's own rules,
so a synchronous stub's elements have folded before the next action is
reduced and before `run` resolves. `subscriptions` in the result carries the
keys declared when `run` resolved, in record order, and every subscription
fiber is interrupted before the Effect returns. A stub that emits
asynchronously (`Stream.tick`, a delayed effect) is not awaited: its late
emission is lost with the interrupt. Seeding `Unmounted` empties the declared
set, so `subscriptions` is `[]`.

## Failure

A subscription whose effect dies is one defect: `Error` folds when the
feature handles it, with `from` set to the key. The runtime does not restart
it; the key stays declared as died.

```ts continue
const Room = define({
  props: Schema.Struct({ roomId: Schema.String }),
  state: Schema.Struct({ online: Schema.Array(Schema.String), failed: Schema.Boolean }),
  actions: Changed,
});

const flaky = Room.create({
  initialState: () => ({ online: [], failed: false }),
  reducer: {
    Changed: ({ userId }, { draft }) => {
      draft.online.push(userId);
      return draft;
    },
    Error: ({ from }, { draft }) => {
      draft.failed = from === "presence:general";
      return draft;
    },
  },
  subscriptions: () => ({
    "presence:general": Subscription.effect(() => Effect.die(new Error("socket closed"))),
  }),
  render: () => null,
});

const died = await Effect.runPromise(
  flaky.run([{ _tag: "Mounted" }], { props: { roomId: "general" }, hooks: {}, layer: Layer.empty }),
);
console.log(died.state);
// => { online: [], failed: true }
console.log(died.defects.map(({ from }) => from));
// => ["presence:general"]
```

Restarting is the feature's decision, expressed through the key: bump an
attempt counter and put it in the key, or reconnect inside the effect.

```ts continue
const reconnecting = Subscription.effect(Changed, (dispatch) =>
  Effect.gen(function* () {
    const api = yield* PresenceApi;
    yield* Stream.runForEach(api.events("general"), (event) => dispatch(Changed, event));
  }).pipe(Effect.retry(Schedule.exponential("1 second"))),
);
```

## `Command.cancel` and a subscription key

`Command.cancel(key)` interrupts fibers in the command book. Subscriptions
are not in that book, so a `cancel` naming a subscription's key reaches
nothing.

```ts continue
const untouched = Presence.reducer({
  Changed: ({ userId }, { draft }) => {
    draft.online.push(userId);
    return [draft, Command.cancel("presence:general")];
  },
});
```

To stop a subscription, stop declaring it: change the snapshot so the key
leaves the hook's return.

## Contextual typing

`A` comes from the contextual type of the slot a `Subscription` value fills,
the same rule `Command.effect` follows, and `R` is read off the effect
itself. Neither takes a type argument at `Definition.subscriptions`.

```ts continue
const inferred = Presence.subscriptions(({ props }) => ({
  [`presence:${props.roomId}`]: Subscription.effect((dispatch) =>
    Effect.gen(function* () {
      const api = yield* PresenceApi;
      yield* Stream.runForEach(api.events(props.roomId), (event) => dispatch(Changed, event));
    }),
  ),
}));
```

`dispatch` is typed `Dispatcher<typeof Changed.Type>` from the record
slot, and `yield* PresenceApi` puts `PresenceApi` into the inferred `R`, with
no annotation on either. `create` infers the same way.

```ts continue
const presenceWithSubscriptions = Presence.create({
  initialState: () => ({ online: [] }),
  reducer: {
    Changed: ({ userId }, { draft }) => {
      draft.online.push(userId);
      return draft;
    },
  },
  subscriptions: ({ props }) => ({
    [`presence:${props.roomId}`]: Subscription.effect((dispatch) =>
      Effect.gen(function* () {
        const api = yield* PresenceApi;
        yield* Stream.runForEach(api.events(props.roomId), (event) => dispatch(Changed, event));
      }),
    ),
  }),
  render: () => null,
});
```

A value with no slot has no contextual type to read. Written standalone, `A`
falls back to `never`, the same way a bare `Effect.Effect<void>` variable
needs its own annotation to carry a service.

```ts continue
// @ts-expect-error dispatch is typed never without a source
const bare = Subscription.effect((dispatch) => dispatch(Changed, { userId: "ada" }));
```

A standalone subscription names the messages it may emit as its first
argument, the same value a `define` slot takes, and `R` is inferred from the
effect. `reconnecting` under [Failure](#failure) is written this way. A type
argument names `A` too (`Subscription.effect<typeof Changed.Type, PresenceApi>`),
and then `R` must be written as well, since TypeScript has no partial
inference.

```ts continue
const named = Subscription.effect(Changed, (dispatch) =>
  Effect.gen(function* () {
    const api = yield* PresenceApi;
    yield* Stream.runForEach(api.events("general"), (event) => dispatch(Changed, event));
  }),
);
```

An annotated `Subscriptions` record is a slot too, so its values infer from
the annotation.

```ts continue
const standalone: Subscriptions<typeof Changed.Type, PresenceApi> = {
  presence: Subscription.effect((dispatch) =>
    Effect.gen(function* () {
      const api = yield* PresenceApi;
      yield* Stream.runForEach(api.events("general"), (event) => dispatch(Changed, event));
    }),
  ),
};
```

A `.pipe` receiver is checked before the contextual type of the `.pipe` call
exists, so a subscription that dispatches loses `A` through `.pipe` the same
way a command does.

```ts continue
const severed: Subscriptions<typeof Changed.Type, PresenceApi> = {
  // @ts-expect-error a .pipe receiver has no contextual type, so dispatch is never
  presence: Subscription.effect((dispatch) => dispatch(Changed, { userId: "ada" })).pipe(
    (self) => self,
  ),
};
```

## Devtools

A diff reports `SubscriptionStarted { key }` before a fiber runs, and
`SubscriptionStopped { key, reason }` with `reason` one of `"Undeclared"`,
`"Completed"`, `"Died"` or `"Unmounted"`. An action or output a subscription
dispatched carries `cause: { _tag: "Subscription", key }`. See
[Devtools](/docs/reference/devtools) for the full event union and the console
logger's output.
