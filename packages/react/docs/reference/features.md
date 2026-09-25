---
title: Features
description: define and its action and output slots, the definition helpers, create, reduce, run, Snapshot, Next and Children.
order: 2
---

# Features

A feature is four schemas and three functions. `define` declares the four,
`create` binds the three, and the result is a plain value with three methods:
`reduce`, `run` and `subscriptions`.

Every snippet on this page builds on one feature: a note editor that holds
draft text and announces a saved note.

```tsx
import { Effect, Layer, Schema } from "effect";
import { Action, Children, Command, define, Next, Task } from "@wych/react";
import type { LazyCommand, Next as NextType, RenderSnapshot, Snapshot } from "@wych/react";

const actions = Action({ Typed: { text: Schema.String }, Saved: {} });
const NoteSaved = Action.output("NoteSaved", { noteId: Schema.String, text: Schema.String });

const NoteEditor = define({
  props: Schema.Struct({ noteId: Schema.String, autosave: Schema.Boolean }),
  state: Schema.Struct({ text: Schema.String, dirty: Schema.Boolean }),
  action: actions,
  output: NoteSaved,
});
```

## `define`

```ts fragment
define({
  props: Schema.Struct, // required
  state: Schema.Struct, // required
  action: MemberSource<"internal">, // required
  output?: MemberSource<"outbound">, // optional
  useUnsafeHooks?: (props, state) => H,
}): FeatureDefinition
```

`props` and `state` are `Schema.Struct`s. `action` and `output` each take a
message, a record of messages (`Action({ ... })`), a
[task](/docs/reference/tasks) operation, or an array of those, one array
nested inside another at most. `define` infers `Props`, `State`, the messages
of each slot and the hooks from that one object literal, so no type argument
is written by hand.

```ts continue
const autosave = Task("Autosave", { success: Schema.String });

const OneMessage = define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  action: actions.Saved,
});

const WithTask = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ text: Schema.String, autosave: autosave.schema }),
  action: [actions, autosave],
  output: [NoteSaved, Action.output("Discarded")],
});
```

The slot fixes the channel: `action` takes internal messages only, `output`
outbound ones. The check is a compile error and, for a source that got past
the types, a throw at `define`.

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  // @ts-expect-error NoteSaved is outbound and cannot be declared in "action"
  action: [actions, NoteSaved],
});
// throws TypeError: define: "NoteSaved" is outbound and cannot be declared in "action"
```

Two more rules are compile errors: an output tag equal to an action tag, and
a prop named after a derived output prop. A tag declared twice across both
slots also throws at `define`.

```ts continue
const Collides = Action.output("Typed");

define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  action: actions.Typed,
  // @ts-expect-error output tag "Typed" collides with an action tag
  output: Collides,
});
// throws TypeError: define: tag "Typed" is declared twice

const propCollision = define({
  props: Schema.Struct({ onNoteSaved: Schema.String }),
  state: Schema.Struct({}),
  action: actions.Saved,
  // @ts-expect-error prop "onNoteSaved" collides with the derived output prop
  output: NoteSaved,
});
```

The member sources a slot takes are in
[The `define` slots](/docs/reference/actions#the-define-slots).

`Children` in the state schema throws at `define`, because state reaches a
devtools sink verbatim and an opaque value does not encode.

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({ children: Children }),
  action: actions.Saved,
});
// throws TypeError: Opaque field "children" declared in the state schema
```

The full message ends with `opaque declarations like Children belong in props`.

### `useUnsafeHooks`

```ts fragment
useUnsafeHooks?: (props: Props, state: State) => H
```

The runtime calls this in render position on every render, so the rules of
hooks hold and `useThing(id)`-shaped hooks work. Its result arrives as
`snapshot.hooks`, and a change in any key raises
[`HookChanged`](/docs/reference/lifecycle).

```ts continue
const WithHooks = define({
  props: Schema.Struct({ noteId: Schema.String }),
  state: Schema.Struct({ text: Schema.String }),
  action: actions.Typed,
  useUnsafeHooks: (props) => ({ storageKey: `note:${props.noteId}` }),
});
```

## What `define` returns

```ts fragment
FeatureDefinition {
  initialState(fn): (props) => State
  reducer(obj): Reducer
  render(fn): Render
  subscriptions(fn): SubscriptionsHook
  create({ initialState, reducer, render, subscriptions? }): Feature
}
```

`initialState`, `reducer` and `render` are identity functions at runtime. They
supply types, so each piece can live in its own file.

```tsx continue
const initialState = NoteEditor.initialState(() => ({ text: "", dirty: false }));

const reducer = NoteEditor.reducer({
  Typed: ({ text }, { draft }) => {
    draft.text = text;
    draft.dirty = true;
    return draft;
  },
  Saved: (_payload, { draft, props }) => {
    draft.dirty = false;
    return [draft, Command.output(NoteSaved, { noteId: props.noteId, text: draft.text })];
  },
});

const render = NoteEditor.render(({ state, dispatch }) => (
  <textarea
    value={state.text}
    onChange={(event) => dispatch(actions.Typed, { text: event.target.value })}
  />
));

export const noteEditor = NoteEditor.create({ initialState, reducer, render });
```

### The reducer

One handler per declared action tag, required and exhaustive. A handler is
`(payload, snapshot) => Next`. `payload` is the action with `_tag` stripped; the
handler key already names the tag.

A handler that returns a key the state schema does not declare is a compile
error.

```ts continue
const excess = NoteEditor.reducer({
  Typed: ({ text }, { draft }) => {
    draft.text = text;
    // @ts-expect-error state has no property "wordCount"
    draft.wordCount = text.length;
    return draft;
  },
  Saved: (_payload, { state }) => state,
});
```

A handler for an output tag is a compile error too. Outputs have no handler.

```ts continue
const outputHandler = NoteEditor.reducer({
  Typed: ({ text }, { draft }) => {
    draft.text = text;
    draft.dirty = true;
    return draft;
  },
  Saved: (_payload, { state }) => state,
  // @ts-expect-error "NoteSaved" is an output, so it has no handler
  NoteSaved: (_payload, { state }) => state,
});
```

Lifecycle handlers are optional. They are listed in
[Lifecycle](/docs/reference/lifecycle).

### `subscriptions`

`create` takes an optional fourth piece, `subscriptions`, for a long-lived
source declared by key rather than started by a handler. It lives beside
`reducer`, not inside it, and does not return a `Next`. See
[Subscriptions](/docs/reference/subscriptions) for the hook, the key rule and
the diff that starts and stops fibers.

## `Snapshot` and `RenderSnapshot`

```ts fragment
interface Snapshot<Props, State, H> {
  readonly state: State;
  readonly props: Props;
  readonly hooks: H;
}

interface RenderSnapshot<Props, State, Action, H> extends Snapshot<Props, State, H> {
  readonly dispatch: Dispatch<Action>;
}
```

A reducer handler receives a `Snapshot`. `render` and `useFeature` receive a
`RenderSnapshot`, which adds `dispatch`.

```tsx continue
type EditorSnapshot = Snapshot<
  { readonly noteId: string; readonly autosave: boolean },
  { readonly text: string; readonly dirty: boolean },
  {}
>;

type EditorRenderSnapshot = RenderSnapshot<
  { readonly noteId: string; readonly autosave: boolean },
  { readonly text: string; readonly dirty: boolean },
  { readonly _tag: "Typed"; readonly text: string },
  {}
>;
```

`render`'s `dispatch` takes a message schema and its payload, or a built
message, and it carries the declared outputs as well, so the view can announce
an output without a mirror action. See
[Runtime](/docs/reference/runtime#dispatch).

## `ReducerSnapshot` and `snapshot.draft`

```ts fragment
interface ReducerSnapshot<Props, State, H> extends Snapshot<Props, State, H> {
  readonly draft: Draft<State>;
}
```

A reducer handler receives a `ReducerSnapshot`: `state`, `props` and `hooks`,
plus `draft`, a mutable view of `state`. Write into it and return it, alone or
beside a command, and the fold replaces it with the finished value before
anything else reads the `Next`. `render` and `subscriptions` receive a plain
`Snapshot`, with no `draft`: neither is a place to change state. The `reducer`
above already writes this way.

```ts fragment
type Draft<T> = T extends { readonly pipe: unknown }
  ? T // Option, Chunk, Effect and the rest of Effect's data types pass through
  : T extends ReadonlyArray<infer E>
    ? Array<Draft<E>>
    : T extends object
      ? { -readonly [K in keyof T]: Draft<T[K]> }
      : T; // primitives and functions pass through
```

Arrays and plain objects lose `readonly`, recursively, so a nested array or
record is as mutable as the top level. Same key set as `State`, so a draft is
assignable to `State`, and an excess key on it is a compile error, the same as
on a spread.

The one place the mutable type bites: a drafted array field is `Array<E>`,
and a `ReadonlyArray<E>` does not go into it. An action payload declared with
`Schema.Array` decodes to a `ReadonlyArray`, so `draft.hits = hits` is a
compile error where `draft.hits = [...hits]` is not. The copy is shallow and
the fold freezes the result either way. `Task.resolved` and `Task.rejected`
are typed for this already, so `draft.results = Task.resolved(value)` needs
no copy.

### Finishing rules

`reduce` applies these for every caller, `run` and the store included:

- Returned the draft, wrote into it: the finished value takes its place.
  Untouched siblings are the same objects as in `state`, and the result is
  deep-frozen.
- Returned the draft, wrote nothing: the finished value is `state` itself, by
  reference. That is the no-op.
- Returned another state, wrote nothing into the draft: the returned state
  wins. Reading the draft costs nothing.
- Returned another state, wrote into the draft: a `TypeError`. Two next states
  and no rule that picks one.

```ts continue
const mixedReducer = NoteEditor.reducer({
  Typed: ({ text }, { state, draft }) => {
    draft.dirty = true;
    return { ...state, text };
  },
  Saved: (_payload, { state }) => state,
});

const mixedFeature = NoteEditor.create({ initialState, reducer: mixedReducer, render });

mixedFeature.reduce(actions.Typed.make({ text: "hi" }), {
  state: { text: "", dirty: false },
  props: { noteId: "n_1", autosave: true },
  hooks: {},
});
// throws TypeError: handler wrote into snapshot.draft and returned a different state
```

A `LazyCommand` in the tuple runs at `Next.command`, after the fold replaced
the draft, so the thunk sees the finished state, never the proxy; the [`Next`
section](#next) below shows it.

### The proxy is revoked once the fold ends

The drafter revokes every proxy at finish. A copy that holds draft children
(`{ ...draft }`) is unreadable once the handler returns: read what you need
before returning, or return the draft itself and let the fold finish it.

```ts continue
let leaked: unknown;

const leakyReducer = NoteEditor.reducer({
  Typed: (_payload, { draft }) => {
    leaked = draft;
    return draft;
  },
  Saved: (_payload, { state }) => state,
});

const leakyFeature = NoteEditor.create({ initialState, reducer: leakyReducer, render });

leakyFeature.reduce(actions.Typed.make({ text: "hi" }), {
  state: { text: "", dirty: false },
  props: { noteId: "n_1", autosave: true },
  hooks: {},
});

let threwOnRead = false;
try {
  (leaked as { text: unknown }).text;
} catch {
  threwOnRead = true;
}
console.log(threwOnRead);
// => true
```

### Spread is still valid

A one-field change reads fine as a spread, and a spread handler beside a
drafting one is unaffected: its result is a plain object, not frozen.

```ts continue
const spreadForm = NoteEditor.reducer({
  Typed: ({ text }, { state }) => ({ ...state, text, dirty: true }),
  Saved: (_payload, { state }) => state,
});
```

## `Next`

```ts fragment
type Next<State, Action, R> = State | readonly [State, Command<Action, R> | LazyCommand<State, Action, R>];
type LazyCommand<State, Action, R> = (state: State) => Command<Action, R>;

Next.state(next): State
Next.command(next): Command | undefined
Next.lazy(state, (next) => command): readonly [State, LazyCommand]
```

A handler returns a bare state, a `[state, command]` tuple, or a
`[state, (next) => command]` lazy tuple. The thunk receives the tuple's own
state, so a handler can write the next state inline and read it in the command
without a local name. `Next.lazy` names that tuple. It infers the state type
from its first argument, so the thunk sees the shape the handler built rather
than the wider state schema.

```ts continue
const lazyReducer = NoteEditor.reducer({
  Typed: ({ text }, { draft }) => {
    draft.text = text;
    draft.dirty = true;
    return Next.lazy(draft, (next) =>
      Command.effect(() => Effect.sync(() => localStorage.setItem("draft", next.text))),
    );
  },
  Saved: (_payload, { state }) => state,
});
```

`Next.command` resolves a lazy command once, by calling it with the tuple's own
state. `Next.state` reads the state whichever form was returned. The thunk
above receives the finished state: the fold has already replaced `draft` with
its frozen value by the time `next.text` is read.

```ts continue
const bare: NextType<{ readonly text: string }, never> = { text: "hello" };

console.log(Next.state(bare));
// => { text: "hello" }
console.log(Next.command(bare));
// => undefined
```

## `Feature.reduce`

```ts fragment
feature.reduce(
  action: Action | LifecycleAction<Props, H>,
  snapshot: Snapshot<Props, State, H>,
  drafter?: DrafterService,
): Next<State, Action | Output, R>
```

The reducer as one pure function. No React, no Effect runtime. `drafter`
builds `snapshot.draft`; it defaults to `mutativeDrafter`, so a test hands one
of its own only to swap the drafting library. See
[Runtime](/docs/reference/runtime#drafter) for `DrafterService` and how to
install a custom one at the root.

```ts continue
const typed = noteEditor.reduce(actions.Typed.make({ text: "hi" }), {
  state: { text: "", dirty: false },
  props: { noteId: "n_1", autosave: true },
  hooks: {},
});

console.log(Next.state(typed));
// => { text: "hi", dirty: true }
```

Three behaviours are specific to `reduce`:

- An unhandled lifecycle action returns `snapshot.state` unchanged.
- For `Unmounted` the handler's returned state is replaced by
  `snapshot.state`. Only the command survives.
- A missing handler for a non-lifecycle tag throws
  `TypeError('No reducer handler for action "X"')`. Only a call that bypasses
  the types can reach this.

```ts continue
const unhandled = noteEditor.reduce(
  { _tag: "Mounted" },
  {
    state: { text: "draft", dirty: true },
    props: { noteId: "n_1", autosave: true },
    hooks: {},
  },
);

console.log(Next.state(unhandled));
// => { text: "draft", dirty: true }
```

`feature.subscriptions(snapshot)` reads the same way: what a snapshot
declares, as a record, without a mount.

```ts continue
console.log(
  Object.keys(
    noteEditor.subscriptions({
      state: { text: "hi", dirty: true },
      props: { noteId: "n_1", autosave: true },
      hooks: {},
    }),
  ),
);
// => []
```

`noteEditor` has no `subscriptions` hook, so every snapshot declares `{}`. See
[Subscriptions](/docs/reference/subscriptions) for a feature that does.

## `Feature.run`

```ts fragment
feature.run(
  actions: Iterable<Action | LifecycleAction<Props, H>>,
  options: { readonly props: Props; readonly hooks: H; readonly layer: Layer.Layer<R> },
): Effect.Effect<{
  state: State;
  emitted: ReadonlyArray<Action>;
  outputs: ReadonlyArray<Output>;
  defects: ReadonlyArray<RunDefect>;
  subscriptions: ReadonlyArray<string>;
}>
```

`run` folds a sequence of built messages, interprets each command against
`layer`, feeds what a command emits back into the reducer, and collects what
left. `make` builds a seed; `make()` takes no argument when every field is
optional.

```ts continue
const result = await Effect.runPromise(
  noteEditor.run([actions.Typed.make({ text: "hi" }), actions.Saved.make()], {
    props: { noteId: "n_1", autosave: true },
    hooks: {},
    layer: Layer.empty,
  }),
);

console.log(result.state);
// => { text: "hi", dirty: false }
console.log(result.emitted);
// => []
console.log(result.outputs);
// => [{ _tag: "NoteSaved", noteId: "n_1", text: "hi" }]
console.log(result.defects);
// => []
```

The five result fields differ:

- `state`: the state after the last fold.
- `emitted`: actions a command or a subscription emitted. Seeded actions are
  folded and are absent here.
- `outputs`: messages whose tag is a declared output. An output is never
  folded.
- `defects`: every command or subscription that died, in the order observed.
- `subscriptions`: the keys declared when `run` resolved, in record order.

`run` resolves at command quiescence: nothing queued, no command fiber in
flight. A command that never completes keeps `run` from resolving, so `run`
never resolves for `Command.effect(() => Effect.never)`. That is what a
command is: work that finishes.

A subscription fiber counts for nothing toward quiescence. A long-lived
source belongs in `subscriptions`: `run` resolves with one in flight,
interrupting it and recording its key in the result. See
[Subscriptions](/docs/reference/subscriptions) for the diff, the key rule and
how `run` treats a synchronous versus an asynchronous stub.

For a feature with no services pass `layer: Layer.empty` and `hooks: {}`. See
[Test a feature without React](/docs/how-to/test-a-feature-without-react).

### `RunDefect`

```ts fragment
interface RunDefect {
  readonly from: string;
  readonly error: unknown;
  readonly handled: boolean;
}
```

One command or subscription death observed by `run`, in the order it was
seen. `from` is the tag of the action whose command died, or the key of the
subscription that died. `error` is the squashed cause: the thrown value, or
what `Effect.die` was given. `handled` is whether the feature's `Error`
handler folded it: `false` with no handler, or when the dying command was the
`Error` handler's own. Interruption (`Command.cancel`, `Command.restart`, an
undeclared subscription key) is how work normally ends and is never a defect.

```ts continue
const Boomed = Action("Boomed");
const dying = Command.effect(() => Effect.die(new Error("kaboom")));

const flaky = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ crashed: Schema.Boolean }),
  action: Boomed,
}).create({
  initialState: () => ({ crashed: false }),
  reducer: {
    Boomed: (_action, { state }) => [state, dying],
    Error: (_action, { draft }) => {
      draft.crashed = true;
      return draft;
    },
  },
  render: () => null,
});

const withError = await Effect.runPromise(
  flaky.run([Boomed.make()], { props: {}, hooks: {}, layer: Layer.empty }),
);

console.log(withError.state);
// => { crashed: true }
console.log(withError.defects.map(({ from, handled }) => ({ from, handled })));
// => [{ from: "Boomed", handled: true }]
console.log(String(withError.defects[0]?.error));
// => "Error: kaboom"
```

The `Error` handler folds before `run` resolves, on the same rule the store
uses: `state` shows the recovery, and `defects` shows the death that caused
it. `handled` is `true` because the feature declared an `Error` handler and
the death was not inside that handler's own command.

## `Children`

```ts fragment
Children: Schema.declare<ReactNode> & { readonly as: <T>() => Schema.declare<T> }
```

`Children` is a props field that accepts any value. Declared plainly, the key
is required, and JSX that passes no children omits the key. `Schema.optionalKey`
is the optional form, and `Children.as<T>()` fixes another type.

```tsx continue
const Panel = define({
  props: Schema.Struct({
    title: Schema.String,
    children: Children,
    footer: Schema.optionalKey(Children),
    row: Children.as<(id: string) => React.ReactNode>(),
  }),
  state: Schema.Struct({ open: Schema.Boolean }),
  action: Action("Toggled"),
});

const panel = Panel.create({
  initialState: Panel.initialState(() => ({ open: true })),
  reducer: Panel.reducer({ Toggled: (_payload, { state }) => ({ open: !state.open }) }),
  render: Panel.render(({ props, state }) => (
    <section>
      {props.title}
      {state.open ? props.children : null}
      {props.row("row_1")}
      {props.footer}
    </section>
  )),
});
```

`Children` compares equal to any value, so a fresh node from a parent render
never raises `PropsChanged`. A reducer's `snapshot.props.children` can
therefore be stale. `render` always has the current node. Devtools replace an
opaque prop with `"<children>"`. See
[Children and opaque props](/docs/explanation/children-and-opaque-props).
