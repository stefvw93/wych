---
title: Actions and outputs
description: Why a feature has two message channels, and why the outbound one never reaches the reducer.
order: 2
---

# Actions and outputs

A confirm dialog in React talks to its parent through callback props:
`onConfirm?: () => void`, `onCancel?: () => void`. The parent may forget one.
The child may call one twice, or after unmount. Nothing in the type says
what the dialog can say, only what the parent happened to wire up.

Wych gives a feature two message channels. Actions come in and reach the
reducer. Outputs go out and leave through a prop that the type requires.

```tsx
import { Action, Command, createRuntime, define, Next } from "@wych/react";
import { Effect, Layer, Schema } from "effect";

const actions = Action({
  Opened: {},
  Typed: { text: Schema.String },
  ConfirmClicked: {},
  Closed: { reason: Schema.String },
});

const outputs = Action.output({
  Confirmed: {},
  Dismissed: { reason: Schema.String },
});

const Dialog = define({
  props: Schema.Struct({ title: Schema.String, confirmWord: Schema.String }),
  state: Schema.Struct({ open: Schema.Boolean, typed: Schema.String }),
  action: actions,
  output: outputs,
});
```

`Action` brands a message internal and `Action.output` brands it outbound.
The brand is a runtime property and a type, so the two channels are not
assignable to each other. The `define` slot is where that is checked:
`action` takes internal messages and `output` takes outbound ones, so a
message in the wrong slot fails to compile, on its own or inside an array.
`define` repeats the check at runtime, for a value that got past the types
through a cast.

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  // @ts-expect-error an outbound message cannot be declared as an action
  action: [actions.Opened, outputs.Confirmed],
});
// throws TypeError: define: "Confirmed" is outbound and cannot be declared in "action"
```

## Why an output never re-enters the reducer

A feature's state is a fold over its own actions. If `Confirmed` could also
be folded, the reducer would have to answer a question the dialog cannot
answer: what did the parent do with it? Close a modal, delete a record,
navigate away. The dialog does not know and should not.

```tsx continue
const reducer = Dialog.reducer({
  Opened: (_payload, { draft }) => {
    draft.open = true;
    draft.typed = "";
    return draft;
  },
  Typed: ({ text }, { draft }) => {
    draft.typed = text;
    return draft;
  },
  ConfirmClicked: (_payload, { draft, state, props }) => {
    if (state.typed !== props.confirmWord) return draft;
    draft.open = false;
    return [draft, Command.output(outputs.Confirmed)];
  },
  Closed: ({ reason }, { draft }) => {
    draft.open = false;
    return [draft, Command.output(outputs.Dismissed, { reason })];
  },
});

const dialog = Dialog.create({
  initialState: () => ({ open: false, typed: "" }),
  reducer,
  render: () => null,
});
```

The reducer's key set is the declared action tags plus the optional
lifecycle tags. An output tag is absent, so there is no handler to write, and
`reduce` refuses one at the call as well.

```ts continue
dialog.reduce(
  // @ts-expect-error an output never reaches the reducer
  { _tag: "Confirmed" },
  {
    state: { open: true, typed: "" },
    props: { title: "Delete", confirmWord: "DELETE" },
    hooks: {},
  },
);
// throws TypeError: No reducer handler for action "Confirmed"
```

`run` shows the split. Actions a command emits are folded and collected in
`emitted`. Outputs are collected in `outputs` and folded nowhere.

```ts continue
const confirmed = await Effect.runPromise(
  dialog.run(
    [actions.Opened.make(), actions.Typed.make({ text: "DELETE" }), actions.ConfirmClicked.make()],
    {
      props: { title: "Delete", confirmWord: "DELETE" },
      hooks: {},
      layer: Layer.empty,
    },
  ),
);

console.log(confirmed.state);
// => { open: false, typed: "DELETE" }
console.log(confirmed.emitted);
// => []
console.log(confirmed.outputs);
// => [{ _tag: "Confirmed" }]
```

A callback prop would have carried the same fact, with no record of it. Here
the announcement is a value the test reads.

## Why `_tag` is stripped at both edges

Each output becomes a required `on<Tag>` prop that receives the payload
alone. The parent cannot forget `onConfirmed`; leaving it out is a compile
error at the JSX.

```tsx continue
const runtime = createRuntime(Layer.empty);
const ConfirmDialog = runtime.component(dialog, { name: "ConfirmDialog" });

const DeleteAccount = () => (
  <ConfirmDialog
    title="Delete account"
    confirmWord="DELETE"
    onConfirmed={() => window.alert("deleted")}
    onDismissed={({ reason }) => console.info(reason)}
  />
);
```

The prop name already carries the tag, so the payload carries no
discriminant to destructure around. A reducer handler is stripped on the same
rule: the handler key did the routing, so what the handler holds is plain
data. A payload stored whole cannot smuggle a tag into state or into a
command.

```ts continue
const next = dialog.reduce(
  { _tag: "Typed", text: "DEL" },
  {
    state: { open: true, typed: "" },
    props: { title: "Delete", confirmWord: "DELETE" },
    hooks: {},
  },
);
// the handler received { text: "DEL" }
console.log(Next.state(next));
// => { open: true, typed: "DEL" }
```

At runtime, an output leaving while its prop is absent throws
`TypeError('No "onConfirmed" prop for output "Confirmed"')` to the nearest
error boundary. That path is unreachable through JSX, because the prop is
required.

## Why `dispatch` routes outputs from the view

`render` and `ConfirmDialog.useFeature()` hand back a `dispatch` that accepts
declared actions and declared outputs. The store routes every message by
tag, so an output dispatched from the view goes straight to its prop.

```tsx continue
import { createRoot } from "react-dom/client";

const announcer = Dialog.create({
  initialState: () => ({ open: true, typed: "" }),
  reducer,
  render: ({ dispatch }) => (
    <button onClick={() => dispatch(outputs.Dismissed, { reason: "escape" })}>Close</button>
  ),
});
const Announcer = runtime.component(announcer, { name: "Announcer" });

const reasons: Array<string> = [];
createRoot(document.getElementById("root")!).render(
  <Announcer
    title="Delete"
    confirmWord="DELETE"
    onConfirmed={() => {}}
    onDismissed={({ reason }) => reasons.push(reason)}
  />,
);
await new Promise((resolve) => setTimeout(resolve, 50)); // let the mount effect run
document.querySelector("button")!.click();

console.log(reasons);
// => ["escape"]
```

Without that route, a view that only announces would need a mirror action
whose one job is to return `Command.output`. That handler writes no state
and exists to satisfy the plumbing.

Route through an action when the feature's own state has to record what
left. `Closed` above is that case: the view dispatches `Closed`, the handler
writes `open: false`, and the command carries `Dismissed` out. The state
change and the announcement come from one fold, so they cannot come apart.

```ts continue
const closed = dialog.reduce(
  { _tag: "Closed", reason: "backdrop" },
  {
    state: { open: true, typed: "" },
    props: { title: "Delete", confirmWord: "DELETE" },
    hooks: {},
  },
);

console.log(Next.state(closed).open);
// => false
console.log(Next.command(closed)?._tag);
// => "Effect"
```

## Why lifecycle tags are reserved

The runtime raises `Mounted`, `PropsChanged`, `HookChanged`, `Error` and
`Unmounted` into the same reducer through the same key lookup. A user
message with one of those tags would be indistinguishable from the runtime's
own, so the five names are rejected at declaration on both channels.

```ts continue
// @ts-expect-error "Mounted" is a lifecycle tag
const Mounted = Action("Mounted");
```

## What the runtime cannot see

An output leaves through a plain React callback into arbitrary parent code.
The runtime cannot know what the parent dispatched next, so devtools report
the `Output` event and the parent's own `Dispatch` cause and claim no edge
between them. A devtools UI can draw that edge from adjacency; the runtime
will not assert it.

Payloads and firing order for the lifecycle actions are in
[lifecycle](/docs/reference/lifecycle). `Action`, `Action.output` and the
`define` slots are in [actions](/docs/reference/actions).
