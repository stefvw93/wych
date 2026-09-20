---
title: Lifecycle
description: "Mounted, PropsChanged, HookChanged, Error and Unmounted: payloads, order and change detection."
order: 6
---

# Lifecycle

The runtime raises five actions. Their tags are reserved, so a feature cannot
declare an action with one of these names. Every handler is optional, and an
unhandled lifecycle action leaves state unchanged.

Every snippet on this page builds on one feature: a presence indicator that
declares a subscription for a room and reports who is online.

```tsx
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect";
import { Action, Command, Next, Subscription, define } from "@wych/react";
import type { LifecycleAction } from "@wych/react";

class Presence extends Context.Service<
  Presence,
  {
    readonly watch: (roomId: string) => Stream.Stream<ReadonlyArray<string>>;
    readonly leave: (roomId: string) => Effect.Effect<void>;
  }
>()("Presence") {}

const PresenceLayer = Layer.succeed(Presence)({
  watch: () => Stream.make(["ada"], ["ada", "grace"]),
  leave: () => Effect.void,
});

const Arrived = Action("Arrived", { members: Schema.Array(Schema.String) });

const Room = define({
  props: Schema.Struct({ roomId: Schema.String }),
  state: Schema.Struct({ members: Schema.Array(Schema.String), failed: Schema.String }),
  action: Action.of([Arrived]),
  useUnsafeHooks: (props) => ({ channel: `room:${props.roomId}` }),
});
```

## The five actions

```ts fragment
type LifecycleAction<Props, H> =
  | { readonly _tag: "Mounted" }
  | { readonly _tag: "PropsChanged"; readonly previous: Props }
  | { readonly _tag: "HookChanged"; readonly previous: H }
  | {
      readonly _tag: "Error";
      readonly error: unknown;
      readonly cause: Cause.Cause<never>;
      readonly from: string;
    }
  | { readonly _tag: "Unmounted" };
```

A handler receives the payload with `_tag` stripped, on the same terms as an
action handler. `Mounted` and `Unmounted` therefore receive `{}`.

```tsx continue
const room = Room.create({
  initialState: Room.initialState(() => ({ members: [], failed: "" })),
  reducer: Room.reducer({
    Arrived: ({ members }, { draft }) => {
      draft.members = [...members];
      return draft;
    },

    PropsChanged: ({ previous }, { draft, props }) => {
      if (previous.roomId === props.roomId) return draft;
      draft.members = [];
      return draft;
    },

    HookChanged: ({ previous }, { state }) => {
      console.log(previous.channel);
      return state;
    },

    Error: ({ error, cause, from }, { draft, props }) => {
      draft.failed =
        from === "Mounted"
          ? "connect failed"
          : from === `watch:${props.roomId}`
            ? "watch died"
            : Cause.hasDies(cause)
              ? "bug"
              : String(error);
      return draft;
    },

    Unmounted: (_payload, { state, props }) => [
      state,
      Command.effect<never, Presence>(() =>
        Effect.gen(function* () {
          const presence = yield* Presence;
          yield* presence.leave(props.roomId);
        }),
      ),
    ],
  }),
  subscriptions: Room.subscriptions(({ props }) => ({
    [`watch:${props.roomId}`]: Subscription.effect((dispatch) =>
      Effect.gen(function* () {
        const presence = yield* Presence;
        yield* Stream.runForEach(presence.watch(props.roomId), (members) =>
          dispatch(Arrived.make({ members })),
        );
      }),
    ),
  })),
  render: Room.render(({ state }) => (
    <ul>
      {state.members.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  )),
});
```

`Mounted` has no handler here: the feature has nothing left to start on mount,
because the room feed is declared through `subscriptions`, not started by a
handler. An unhandled lifecycle action returns state unchanged, which is why
`Mounted` is safe to leave out. See [Subscriptions](/docs/reference/subscriptions)
for the hook, the key rule and the diff that starts and stops fibers.

## Order

1. `Mounted`, once per mount, raised from an effect after the commit. The
   `subscriptions` hook is evaluated right after, against the post-`Mounted`
   snapshot, whether or not `Mounted` moved state.
2. `PropsChanged` and `HookChanged`, whenever their values change. The hook is
   evaluated again after either fires.
3. `Error`, at any point from the mount effect on, including during teardown.
   It fires when a command dies, when a subscription dies, when a handler
   throws, or when the feature `layer` fails to build.
4. `Unmounted`, at teardown.

`Mounted` fires once per effect cycle, so it fires twice under React
StrictMode in development. Write a `Mounted` handler to be idempotent: a
command it returns can fold twice, once from each mount, because a command
that resolves during the second mount's life still folds into the surviving
store. `Task.resolved(value)` replaces on a second fold and is fine; an
append is not.

```ts continue
const mounted = room.reduce(
  { _tag: "Mounted" },
  {
    state: { members: [], failed: "" },
    props: { roomId: "r_1" },
    hooks: { channel: "room:r_1" },
  },
);

console.log(Next.state(mounted));
// => { members: [], failed: "" }
console.log(Next.command(mounted) !== undefined);
// => false
```

`Mounted` returns no command here, because there is no handler for it.
`Mounted` is the first lifecycle action a feature folds. A props change that
lands in the first commit folds `PropsChanged` after it, and its command runs
after the `Mounted` command.

## `PropsChanged`

Props are compared by value with `Schema.toEquivalence` over the props schema.
An unchanged parent re-render folds nothing, and returning the same state
reference is the no-op.

```ts continue
const sameRoom = room.reduce(
  { _tag: "PropsChanged", previous: { roomId: "r_1" } },
  {
    state: { members: ["ada"], failed: "" },
    props: { roomId: "r_1" },
    hooks: { channel: "room:r_1" },
  },
);

console.log(Next.command(sameRoom));
// => undefined

const newRoom = room.reduce(
  { _tag: "PropsChanged", previous: { roomId: "r_1" } },
  {
    state: { members: ["ada"], failed: "" },
    props: { roomId: "r_2" },
    hooks: { channel: "room:r_2" },
  },
);

console.log(Next.state(newRoom));
// => { members: [], failed: "" }
```

A changed `roomId` also changes the key `subscriptions` returns, so the
runtime stops the old room's fiber and starts the new one when the render
that carries the new prop commits, before the browser paints. `PropsChanged`
here only resets `members`; nothing in the reducer starts, rebooks or cancels
the feed.

The runtime compares props after a render commits, never during the render.
A render that React abandons, such as a transition that suspends, raises no
`PropsChanged` and starts no subscription. A props change costs two renders
and one paint. The first carries the new props, the second carries the state
`PropsChanged` produced, and both land in the same frame.

A `Children` prop is opaque and compares equal to any value, so a fresh node
never raises `PropsChanged`. The reducer's `snapshot.props.children` can
be stale. `render` always has the current node.

The reported `previous` in a devtools event has each opaque prop replaced by
`"<children>"`. The reducer's own snapshot keeps the real node.

## `HookChanged` and `useUnsafeHooks`

`useUnsafeHooks: (props, state) => H` is called in render position on every
render. Its result arrives as `snapshot.hooks`. Hooks are compared per key with
strict equality (`===`), and a change in any key raises `HookChanged { previous }`.

```ts continue
const hookChanged = room.reduce(
  { _tag: "HookChanged", previous: { channel: "room:r_1" } },
  {
    state: { members: ["ada"], failed: "" },
    props: { roomId: "r_2" },
    hooks: { channel: "room:r_2" },
  },
);

console.log(Next.state(hookChanged));
// => { members: ["ada"], failed: "" }
```

A hook returning a fresh object or a fresh function on every render raises
`HookChanged` on every render. Memoize inside the hook, or return primitives.

A key built from `snapshot.hooks` restarts under the same rule: the runtime
evaluates the `subscriptions` hook after a `HookChanged` fold, on the same
terms as after `PropsChanged`.

`useUnsafeHooks` reads the state the render reads. When `PropsChanged` moves
state, the feature renders again before the browser paints. The hook runs
against the new state, and a changed value raises `HookChanged` in the same
frame. A `HookChanged` handler whose state change moves the hook value again
never settles, and it hits React's update limit. Derive a value that holds
still once state has caught up.

## `Error`

```ts fragment
Error: (
  payload: { readonly error: unknown; readonly cause: Cause.Cause<never>; readonly from: string },
  snapshot,
) => Next;
```

Four things reach this handler as defects: a command that dies, a subscription
that dies, a handler that throws, and a feature `layer` that fails to build.
`error` is the squashed cause. `cause` is `Cause.die(error)`, for a handler
that wants a `Cause` value. `from` names the origin: the tag of the action
whose command died or whose handler threw, the key of the subscription that
died, `"Mounted"` for a layer that failed to build, or `"Unmounted"` for a
teardown that threw or overran.

`from` lets a handler tell infrastructure from a single bad command or a dead
subscription: back off when `from === "Mounted"`, because the layer itself
cannot build; check `from` against a known subscription key to react to a
dead feed specifically; carry on for anything else, because one death does
not mean the next will happen.

```ts continue
const connectFailed = room.reduce(
  {
    _tag: "Error",
    error: new Error("connection refused"),
    cause: Cause.die(new Error("connection refused")),
    from: "Mounted",
  },
  {
    state: { members: [], failed: "" },
    props: { roomId: "r_1" },
    hooks: { channel: "room:r_1" },
  },
);

console.log(Next.state(connectFailed));
// => { members: [], failed: "connect failed" }

const watchDied = room.reduce(
  {
    _tag: "Error",
    error: new Error("socket closed"),
    cause: Cause.die(new Error("socket closed")),
    from: "watch:r_1",
  },
  {
    state: { members: ["ada"], failed: "" },
    props: { roomId: "r_1" },
    hooks: { channel: "room:r_1" },
  },
);

console.log(Next.state(watchDied));
// => { members: ["ada"], failed: "watch died" }
```

With no `Error` handler declared, the defect is rethrown during render and
reaches the nearest React error boundary. An `Error` handler that throws goes
to the boundary too. Interruption is never reported as a defect:
`Command.cancel`, an undeclared subscription key and unmount end fibers on
purpose.

A missing `on<Tag>` prop for an output also throws to the boundary, and it does
not reach this handler.

A subscription that dies stays dead under its key: the runtime does not
restart it. The feature restarts it by changing the key, or reconnects inside
the effect with `Effect.retry`. See
[Failure](/docs/reference/subscriptions#failure) for the recipe.

During teardown, `Error` fires when the `Unmounted` handler throws, when the
`Unmounted` command dies, or when teardown passes its 5 second bound. For the
first two, the `Error` handler's command runs in the teardown drain. For the
5 second bound, the mount has already closed by the time the handler runs, so
a command it returns is queued and never runs. All three report
`from: "Unmounted"`.

A mount whose `layer` failed to build stays dead until the next dispatch that
did not come from a lifecycle action or a running command, such as a click
handler calling `dispatch`. That dispatch rebuilds the layer and folds
`Mounted` again; a permanently failing layer rebuilds once per dispatch,
reaching this handler again with `from: "Mounted"`, rather than looping on its
own. See [Recover from a failed layer](/docs/how-to/recover-from-a-failed-layer)
for the Retry and give-up recipe.

A layer that failed to build leaves no mount fiber for a command to run in, so
a command this handler returns for `from: "Mounted"` is dropped, reported to
devtools as a `Command` event with `dropped: true`. Only a command a dispatch
produces rebuilds the layer, which is why the recipe renders a Retry button
rather than returning a command straight from the handler. Report a layer
failure itself with `Layer.tapErrorCause` (or `Effect.tapErrorCause` in its
acquire), which runs under the root runtime, or watch for the `Defect` event
with `from: "Mounted"` from a devtools sink.

## `Unmounted`

The component is gone, so the runtime reads `Next.command(next)` and discards
the rest. Return `snapshot.state` and put the work in the command.

```ts continue
const torn = room.reduce(
  { _tag: "Unmounted" },
  {
    state: { members: ["ada"], failed: "" },
    props: { roomId: "r_1" },
    hooks: { channel: "room:r_1" },
  },
);

console.log(Next.state(torn));
// => { members: ["ada"], failed: "" }
console.log(Next.command(torn)?._tag);
// => "Effect"
```

`reduce` discards the returned state the same way the runtime does, so a
teardown test cannot disagree with the mount.

Teardown, in order:

1. Every subscription fiber is interrupted and awaited, and
   `SubscriptionStopped { reason: "Unmounted" }` is reported for each.
2. The `Unmounted` command is interpreted, with the feature's services still
   alive.
3. The mount drains until every in-flight command finishes and what it emits
   folds. In-flight commands are not interrupted at this point.

The whole sequence is bounded at 5 seconds. An overrun is one defect
(`from: "Unmounted"`) and the scope closes anyway. To drop a slow command
instead of waiting for it, cancel its group from the `Unmounted` handler:
`Unmounted: (_payload, { state }) => [state, Command.cancel("slow")]`.

The teardown command runs before the drain, not after it, so a `Cancel` it
carries can still reach the in-flight fibers it targets.

## Server rendering

Nothing folds under `renderToString`: no `Mounted` and no commands. The store
starts in an effect, and effects do not run on the server. See
[Render on the server](/docs/how-to/render-on-the-server).
