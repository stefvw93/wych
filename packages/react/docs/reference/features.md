---
title: Features
description: define, the definition helpers, create, reduce, run, Snapshot, Next and Children.
order: 2
---

# Features

A feature is four schemas and three functions. `define` declares the four,
`create` binds the three, and the result is an inert value with two methods:
`reduce` and `run`.

Every snippet on this page builds on one feature: a note editor that holds
draft text and announces a saved note.

```tsx
import { Effect, Layer, Schema } from "effect";
import { Action, Children, Command, define, Next } from "@wych/react";
import type { LazyCommand, Next as NextType, RenderSnapshot, Snapshot } from "@wych/react";

const Typed = Action("Typed", { text: Schema.String });
const Saved = Action("Saved", {});
const NoteSaved = Action.output("NoteSaved", { noteId: Schema.String, text: Schema.String });

const NoteEditor = define({
  props: Schema.Struct({ noteId: Schema.String, autosave: Schema.Boolean }),
  state: Schema.Struct({ text: Schema.String, dirty: Schema.Boolean }),
  action: Action.of([Typed, Saved]),
  output: Action.of([NoteSaved]),
});
```

## `define`

```ts fragment
define({
  props: Schema.Struct,      // required
  state: Schema.Struct,      // required
  action: Action.of([...]),  // required, internal channel
  output?: Action.of([...]), // optional, outbound channel
  useUnsafeHooks?: (props, state) => H,
}): FeatureDefinition
```

`props` and `state` are `Schema.Struct`s. `action` and `output` are
vocabularies built with `Action.of`. `define` infers `Props`, `State`, the two
vocabularies and the hooks from that one object literal, so no type argument is
ever written by hand.

Three rules are compile errors:

```ts continue
const Collides = Action.of([Action.output("Typed", {})]);

const tagCollision = define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  action: Action.of([Typed]),
  // @ts-expect-error output tag "Typed" collides with an action tag
  output: Collides,
});

const propCollision = define({
  props: Schema.Struct({ onNoteSaved: Schema.String }),
  state: Schema.Struct({}),
  action: Action.of([Saved]),
  // @ts-expect-error prop "onNoteSaved" collides with the derived output prop
  output: Action.of([NoteSaved]),
});
```

`Children` in the state schema throws, because state reaches a devtools sink
verbatim and an opaque value does not encode.

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({ children: Children }),
  action: Action.of([Saved]),
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
  action: Action.of([Typed]),
  useUnsafeHooks: (props) => ({ storageKey: `note:${props.noteId}` }),
});
```

## What `define` returns

```ts fragment
FeatureDefinition {
  initialState(fn): (props) => State
  reducer(obj): Reducer
  render(fn): Render
  create({ initialState, reducer, render }): Feature
}
```

`initialState`, `reducer` and `render` are identity functions at runtime. They
supply types, which is what lets each piece live in its own file.

```tsx continue
const initialState = NoteEditor.initialState(() => ({ text: "", dirty: false }));

const reducer = NoteEditor.reducer({
  Typed: ({ text }, { state }) => ({ ...state, text, dirty: true }),
  Saved: (_payload, { state, props }) => [
    { ...state, dirty: false },
    Command.output(NoteSaved, { noteId: props.noteId, text: state.text }),
  ],
});

const render = NoteEditor.render(({ state, dispatch }) => (
  <textarea
    value={state.text}
    onChange={(event) => dispatch({ _tag: "Typed", text: event.target.value })}
  />
));

export const noteEditor = NoteEditor.create({ initialState, reducer, render });
```

### The reducer

One handler per declared action tag, required and exhaustive. A handler is
`(payload, snapshot) => Next`. `payload` is the action with `_tag` stripped,
because the handler key already named the tag.

A handler that returns a key the state schema does not declare is a compile
error.

```ts continue
const excess = NoteEditor.reducer({
  // @ts-expect-error state has no property "wordCount"
  Typed: ({ text }, { state }) => ({ ...state, text, wordCount: text.length }),
  Saved: (_payload, { state }) => state,
});
```

A handler for an output tag is a compile error too: outputs have no handler.

```ts continue
const outputHandler = NoteEditor.reducer({
  Typed: ({ text }, { state }) => ({ ...state, text, dirty: true }),
  Saved: (_payload, { state }) => state,
  // @ts-expect-error "NoteSaved" is an output, so it has no handler
  NoteSaved: (_payload, { state }) => state,
});
```

Lifecycle handlers are optional. They are listed in
[Lifecycle](/docs/reference/lifecycle).

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

`render`'s `dispatch` carries the outbound vocabulary as well, so the view can
announce an output without a mirror action.

## `Next`

```ts fragment
type Next<State, Action, R> = State | readonly [State, Command<Action, R> | LazyCommand<State, Action, R>];
type LazyCommand<State, Action, R> = (state: State) => Command<Action, R>;

Next.state(next): State
Next.command(next): Command | undefined
```

A handler returns a bare state, a `[state, command]` tuple, or a
`[state, (next) => command]` lazy tuple. The thunk receives the tuple's own
state, so a handler can write the next state inline and hand it to the command
without naming it first.

```ts continue
const lazyReducer = NoteEditor.reducer({
  Typed: ({ text }, { state }) => [
    { ...state, text, dirty: true },
    (next) => Command.effect(() => Effect.sync(() => localStorage.setItem("draft", next.text))),
  ],
  Saved: (_payload, { state }) => state,
});
```

`Next.command` resolves a lazy command once, by calling it with the tuple's own
state. `Next.state` reads the state whichever form was returned.

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
): Next<State, Action | Output, R>
```

The reducer as one pure function. No React, no Effect runtime.

```ts continue
const typed = noteEditor.reduce(Typed.make({ text: "hi" }), {
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
  `TypeError('No reducer handler for action "X"')`. That is reachable only by
  bypassing the types.

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

## `Feature.run`

```ts fragment
feature.run(
  actions: Iterable<Action | LifecycleAction<Props, H>>,
  options: { readonly props: Props; readonly hooks: H; readonly layer: Layer.Layer<R> },
): Effect.Effect<{ state: State; emitted: ReadonlyArray<Action>; outputs: ReadonlyArray<Output> }>
```

`run` folds a sequence of actions, interprets each command against `layer`,
feeds what a command emits back into the reducer, and collects what left.

```ts continue
const result = await Effect.runPromise(
  noteEditor.run([Typed.make({ text: "hi" }), Saved.make({})], {
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
```

The three result fields differ:

- `state`: the state after the last fold.
- `emitted`: actions a command emitted. Seeded actions are folded and are
  absent here.
- `outputs`: messages whose tag is a declared output. An output is never
  folded.

`run` resolves at quiescence: nothing queued and nothing in flight, including
fibers that settle without emitting. A never-completing command pins the
in-flight count, so `run` never resolves for
`Command.effect(() => Effect.never)`.

For a feature with no services pass `layer: Layer.empty` and `hooks: {}`. See
[Test a feature without React](/docs/how-to/test-a-feature-without-react).

## `Children`

```ts fragment
Children: Schema.declare<ReactNode> & { readonly as: <T>() => Schema.declare<T> }
```

`Children` is a props field that validates any value. Declared plainly the key
is required, because JSX passing no children omits the key. `Schema.optionalKey`
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
  action: Action.of([Action("Toggled", {})]),
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

`Children` carries a constantly-true equivalence, so a fresh node from a parent
render never raises `PropsChanged`. A reducer's `snapshot.props.children` can
therefore be stale. `render` always has the current node. Devtools replace an
opaque prop with `"<children>"`. See
[Children and opaque props](/docs/explanation/children-and-opaque-props).
