---
title: Lifecycle
description: "Mounted, PropsChanged, HookChanged, Error and Unmounted: payloads, order and change detection."
order: 5
---

# Lifecycle

The runtime raises five actions. Their tags are reserved, so a feature cannot
declare an action with one of these names. Every handler is optional, and an
unhandled lifecycle action leaves state unchanged.

Every snippet on this page builds on one feature: a presence indicator that
subscribes to a room and reports who is online.

```tsx
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect";
import { Action, Command, define, Next } from "@wych/react";
import type { LifecycleAction } from "@wych/react";

class Presence extends Context.Service<
  Presence,
  { readonly watch: (roomId: string) => Stream.Stream<ReadonlyArray<string>> }
>()("Presence") {}

const PresenceLayer = Layer.succeed(Presence)({
  watch: () => Stream.make(["ada"], ["ada", "grace"]),
});

const Arrived = Action("Arrived", { members: Schema.Array(Schema.String) });

const watch = (roomId: string) =>
  Command.restart(
    "watch",
    Command.effect<{ readonly _tag: "Arrived"; readonly members: ReadonlyArray<string> }, Presence>(
      (dispatch) =>
        Effect.flatMap(Presence, (presence) =>
          Stream.runForEach(presence.watch(roomId), (members) =>
            dispatch({ _tag: "Arrived", members }),
          ),
        ),
    ),
  );

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
  | { readonly _tag: "Error"; readonly error: unknown; readonly cause: Cause.Cause<never> }
  | { readonly _tag: "Unmounted" };
```

A handler receives the payload with `_tag` stripped, on the same terms as an
action handler. `Mounted` and `Unmounted` therefore receive `{}`.

```tsx continue
const room = Room.create({
  initialState: Room.initialState(() => ({ members: [], failed: "" })),
  reducer: Room.reducer({
    Arrived: ({ members }, { state }) => ({ ...state, members }),

    Mounted: (_payload, { state, props }) => [state, watch(props.roomId)],

    PropsChanged: ({ previous }, { state, props }) =>
      previous.roomId === props.roomId ? state : [{ ...state, members: [] }, watch(props.roomId)],

    HookChanged: ({ previous }, { state }) => {
      console.log(previous.channel);
      return state;
    },

    Error: ({ error, cause }, { state }) => ({
      ...state,
      failed: Cause.hasDies(cause) ? "bug" : String(error),
    }),

    Unmounted: (_payload, { state }) => [state, Command.cancel("watch")],
  }),
  render: Room.render(({ state }) => (
    <ul>
      {state.members.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  )),
});
```

## Order

1. `Mounted`, once per mount, raised from an effect after the commit.
2. `PropsChanged` and `HookChanged`, whenever their values change.
3. `Unmounted`, at teardown.

`Mounted` fires once per effect cycle, so it fires twice under React
StrictMode in development. Write the handler to be idempotent.

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
// => true
```

One window is uncovered: a props change landing between the first render and
the mount effect buffers its command ahead of `Mounted`'s.

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

A `Children` prop is opaque and its equivalence is constantly true, so a fresh
node never raises `PropsChanged`. The reducer's `snapshot.props.children` can
be stale. `render` always has the current node.

The reported `previous` in a devtools event has each opaque prop replaced by
`"<children>"`. The reducer's own snapshot keeps the real node.

## `HookChanged` and `useUnsafeHooks`

`useUnsafeHooks: (props, state) => H` is called in render position on every
render. Its result arrives as `snapshot.hooks`. Hooks are compared per key with
`Object.is`, and a change in any key raises `HookChanged { previous }`.

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

`useUnsafeHooks` sees the committed state read before the fold of
`PropsChanged` and `HookChanged`, so a hook value derived from state can lag
until the next dispatch or ambient change.

## `Error`

```ts fragment
Error: (payload: { readonly error: unknown; readonly cause: Cause.Cause<never> }, snapshot) => Next;
```

Two things reach this handler as defects: a command that dies, and a feature
`layer` that fails to build. `error` is the squashed cause. `cause` is the real
one, for a handler that wants to tell a defect from a typed failure.

```ts continue
const failed = room.reduce(
  {
    _tag: "Error",
    error: new Error("socket closed"),
    cause: Cause.die(new Error("socket closed")),
  },
  {
    state: { members: [], failed: "" },
    props: { roomId: "r_1" },
    hooks: { channel: "room:r_1" },
  },
);

console.log(Next.state(failed));
// => { members: [], failed: "bug" }
```

With no `Error` handler declared, the defect is rethrown during render and
reaches the nearest React error boundary. Interruption is never reported as a
defect: `Command.cancel` and unmount end fibers on purpose.

A missing `on<Tag>` prop for an output also throws to the boundary, and it does
not reach this handler.

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
// => "Cancel"
```

`reduce` discards the returned state the same way the runtime does, so a
teardown test cannot disagree with the mount.

Two ordering facts about teardown:

- In-flight work is interrupted before the `Unmounted` command is interpreted.
  A flush-on-exit belongs in the `Unmounted` handler.
- The `Unmounted` command runs with the feature's services still alive, then
  the mount scope closes. Teardown is bounded at 5 seconds; an abandoned
  teardown is reported as a defect.

The teardown command is unkeyed, so it books under the group `"Unmounted"`.

## Server rendering

Nothing folds under `renderToString`: no `Mounted`, no commands. Effects do not
run on the server, and the store's arming lives in an effect. See
[Render on the server](/docs/how-to/render-on-the-server).
