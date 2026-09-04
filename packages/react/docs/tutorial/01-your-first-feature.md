---
title: Your first feature
description: Build a NoteEditor feature, mount it in React, and fold one action without React.
order: 1
example: note-editor
---

# Your first feature

You build a note editor. It holds the text of one note, tracks whether the text
moved away from what the parent passed, and reverts on demand.

State lives in the feature. By the end of this page you have three
files and a feature you can fold in a test with no DOM.

## 1. Create the runtime

The runtime is the root of everything Wych mounts. It takes one `Layer`, the
services your commands ask for. This feature asks for nothing, so the layer is
empty.

```ts
// runtime.ts
import { Layer } from "effect";
import { createRuntime } from "@wych/react";

export const { component } = createRuntime(Layer.empty);
```

`createRuntime` also returns `Provider` and `useRuntime`. You do not need them
yet.

## 2. Declare the shapes

`define` declares what a feature is made of. Props and state are
`Schema.Struct`s. Actions are a tagged vocabulary. Outputs, the fourth
declaration, wait until [chapter 3](/docs/tutorial/composing-features).

```ts continue
// note-editor.tsx
import { Schema } from "effect";
import { Action, define } from "@wych/react";

const TextChanged = Action("TextChanged", { text: Schema.String });
const Reverted = Action("Reverted", {});

const Editor = define({
  props: Schema.Struct({ noteId: Schema.String, initialText: Schema.String }),
  state: Schema.Struct({ text: Schema.String, dirty: Schema.Boolean }),
  action: Action.of([TextChanged, Reverted]),
});
```

`Editor` is a definition. It hands back four helpers
(`initialState`, `reducer`, `render`, `create`), each already typed against
these schemas.

## 3. Write the initial state

`initialState` receives the props the parent passed on mount.

```ts continue
const initialState = Editor.initialState((props) => ({
  text: props.initialText,
  dirty: false,
}));
```

## 4. Write the reducer

One handler per action tag, exhaustive. A handler receives the action's
payload and a snapshot.

```ts continue
const reducer = Editor.reducer({
  TextChanged: (payload, snapshot) => ({
    text: payload.text,
    dirty: payload.text !== snapshot.props.initialText,
  }),
  Reverted: (_payload, snapshot) => ({ text: snapshot.props.initialText, dirty: false }),
});
```

The reducer is pure. It returns the next state. Nothing here runs an effect and
nothing mutates `snapshot.state`.

> `payload` is the action without its `_tag`: for `TextChanged` that is
> `{ text }`, for `Reverted` it is `{}`. `snapshot` is `{ state, props, hooks }`.
> Later chapters destructure both, `({ text }, { props })`, once the shape is
> familiar.

## 5. Write the view

`render` receives the same snapshot plus `dispatch`. `dispatch` takes a whole
message, which `make` builds from the payload.

```tsx continue
const render = Editor.render(({ state, dispatch }) => (
  <form>
    <textarea
      value={state.text}
      onChange={(event) => dispatch(TextChanged.make({ text: event.target.value }))}
    />
    <button type="button" disabled={!state.dirty} onClick={() => dispatch(Reverted.make({}))}>
      Revert
    </button>
  </form>
));
```

## 6. Build the feature and its component

`create` turns the three pieces into a `Feature`. `component` turns the feature
into a React component.

```tsx continue
const editor = Editor.create({ initialState, reducer, render });

export const NoteEditor = component(editor, { name: "NoteEditor" });
```

> `name` appears in error messages, in React devtools as `displayName`, and in
> every Wych devtools event. It defaults to `"WychFeature"`, which cannot tell two
> features apart, so set it.

## 7. Mount it

`NoteEditor` is an ordinary React component. Its props are the props schema.

```tsx continue
// main.tsx
import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root")!);
root.render(<NoteEditor noteId="n1" initialText="Buy milk" />);
```

Type in the textarea and the button enables. Press it and the text returns to
`"Buy milk"`.

Props are validated on mount and whenever the props identity changes. An extra
prop or a wrong type throws a `TypeError` to the nearest error boundary.

## 8. Test it without React

`feature.reduce` is the reducer as one pure function. It needs no DOM and no
Effect runtime, so a test hands it an action and a snapshot and reads what
came back.

```ts continue
import { Next } from "@wych/react";

const next = editor.reduce(TextChanged.make({ text: "Buy oats" }), {
  state: { text: "Buy milk", dirty: false },
  props: { noteId: "n1", initialText: "Buy milk" },
  hooks: {},
});

console.log(Next.state(next));
// => { text: "Buy oats", dirty: true }
console.log(Next.command(next));
// => undefined
```

As a vitest file, that is the whole test. Nothing renders and nothing is
mocked.

```ts fragment
// note-editor.test.ts
import { Next } from "@wych/react";
import { expect, test } from "vitest";
import { editor, TextChanged } from "./note-editor";

test("typing marks the note dirty", () => {
  const next = editor.reduce(TextChanged.make({ text: "Buy oats" }), {
    state: { text: "Buy milk", dirty: false },
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
  });

  expect(Next.state(next)).toEqual({ text: "Buy oats", dirty: true });
  expect(Next.command(next)).toBeUndefined();
});
```

> `reduce` returns a `Next`: a bare state, or a `[state, command]` tuple.
> `Next.state` and `Next.command` read either shape, so a test never matches on
> the tuple. This handler returned no command, so `Next.command` is `undefined`.

## The files

```sh
src/
  main.tsx             # createRoot and the mount
  note-editor.test.ts  # reduce, one action, no DOM
  note-editor.tsx      # define, initialState, reducer, render, create, component
  runtime.ts           # createRuntime, exports component
```

The snippets above type-check as one module. Split across the files, the
imports between them are:

```ts fragment
import { component } from "./runtime"; // note-editor.tsx
import { NoteEditor } from "./note-editor"; // main.tsx
import { editor, TextChanged } from "./note-editor"; // note-editor.test.ts
```

`npm run dev` starts the app and `npm test` runs the test. The example behind
the "Open in StackBlitz" button is this file set.

## Next

The editor holds text and nothing else. Saving it needs a service, a command,
and a place to put the pending state. That is
[chapter 2](/docs/tutorial/async-work).

For the full contract of `define`, `create`, `reduce` and `Next`, see
[Features](/docs/reference/features). For `component` and props validation, see
[Runtime](/docs/reference/runtime).
