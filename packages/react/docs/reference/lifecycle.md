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
        Effect.gen(function* () {
          const presence = yield* Presence;
          yield* Stream.runForEach(presence.watch(roomId), (members) =>
            dispatch({ _tag: "Arrived", members }),
          );
        }),
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
    Arrived: ({ members }, { state }) => ({ ...state, members }),

    Mounted: (_payload, { state, props }) => [state, watch(props.roomId)],

    PropsChanged: ({ previous }, { state, props }) =>
      previous.roomId === props.roomId ? state : [{ ...state, members: [] }, watch(props.roomId)],

    HookChanged: ({ previous }, { state }) => {
      console.log(previous.channel);
      return state;
    },

    Error: ({ error, cause, from }, { state }) => ({
      ...state,
      failed: from === "Mounted" ? "connect failed" : Cause.hasDies(cause) ? "bug" : String(error),
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
3. `Error`, at any point from the mount effect on, including during teardown.
   It fires when a command dies, when a handler throws, or when the feature
   `layer` fails to build.
4. `Unmounted`, at teardown.

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

A props change between the first render and the mount effect folds before
`Mounted`, so its command is queued ahead of the `Mounted` command.

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

`useUnsafeHooks` sees the committed state read before the fold of
`PropsChanged` and `HookChanged`, so a hook value derived from state can lag
until the next dispatch or ambient change.

## `Error`

```ts fragment
Error: (
  payload: { readonly error: unknown; readonly cause: Cause.Cause<never>; readonly from: string },
  snapshot,
) => Next;
```

Three things reach this handler as defects: a command that dies, a handler
that throws, and a feature `layer` that fails to build. `error` is the squashed
cause. `cause` is `Cause.die(error)`, for a handler that wants a `Cause` value.
`from` names the origin: the tag of the action whose command died or whose
handler threw, `"Mounted"` for a layer that failed to build, or `"Unmounted"`
for a teardown that threw or overran.

`from` lets a handler tell infrastructure from a single bad command: back off
when `from === "Mounted"`, because the layer itself cannot build; carry on
for anything else, because one command failing does not mean the next will.

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

const commandDied = room.reduce(
  {
    _tag: "Error",
    error: new Error("socket closed"),
    cause: Cause.die(new Error("socket closed")),
    from: "Arrived",
  },
  {
    state: { members: [], failed: "" },
    props: { roomId: "r_1" },
    hooks: { channel: "room:r_1" },
  },
);

console.log(Next.state(commandDied));
// => { members: [], failed: "bug" }
```

With no `Error` handler declared, the defect is rethrown during render and
reaches the nearest React error boundary. An `Error` handler that throws goes
to the boundary too. Interruption is never reported as a defect: `Command.cancel`
and unmount end fibers on purpose.

A missing `on<Tag>` prop for an output also throws to the boundary, and it does
not reach this handler.

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

Nothing folds under `renderToString`: no `Mounted` and no commands. The store
starts in an effect, and effects do not run on the server. See
[Render on the server](/docs/how-to/render-on-the-server).
