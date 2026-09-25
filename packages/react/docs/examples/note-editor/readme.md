# note-editor

## Overview

A note editor in three files plus one test: `runtime.ts` builds the runtime,
`note-editor.tsx` declares and creates the feature with the split-declaration
form (`Editor.initialState`, `Editor.reducer`, `Editor.render`), `main.tsx`
mounts it, and `note-editor.test.ts` folds one action with no DOM.

## Problem

The editor holds the text of one note, tracks whether it moved away from what
the parent passed, and reverts on demand. The React habit is `useState` in the
component. Then the text lives in React and nowhere else. The dirty rule is a
comparison inside the change handler, and Revert needs its own copy of the
initial text. The only way to test either is to mount the component and type
into it.

## Solution

`note-editor.tsx` declares the two actions as one record,
`Action({ TextChanged: { text: Schema.String }, Reverted: {} })`, defines the
feature once with `define`, then builds each piece separately:
`Editor.initialState`, `Editor.reducer`, and `Editor.render`. The
`TextChanged` handler recomputes `dirty` by comparing against
`props.initialText`, and `Reverted` restores it:

```tsx fragment
const reducer = Editor.reducer({
  TextChanged: (payload, snapshot) => {
    snapshot.draft.text = payload.text;
    snapshot.draft.dirty = payload.text !== snapshot.props.initialText;
    return snapshot.draft;
  },
  Reverted: (_payload, snapshot) => {
    snapshot.draft.text = snapshot.props.initialText;
    snapshot.draft.dirty = false;
    return snapshot.draft;
  },
});
```

`dispatch` takes a message and its payload: `dispatch(actions.TextChanged, { text })`,
and `dispatch(actions.Reverted)` for a message with no fields.

## How It Works

`runtime.ts` calls `createRuntime(Layer.empty)` and exports `component`, which
`note-editor.tsx` uses to build `NoteEditor`. `main.tsx` mounts
`<NoteEditor noteId="n1" initialText="Buy milk" />`. `note-editor.test.ts`
calls `editor.reduce` with a built `actions.TextChanged.make({ text })` and a
hand-written `state`/`props` snapshot, and asserts on `Next.state` and
`Next.command`.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev` for the
app and `npm test` for the test. Inside this monorepo, run
`vp -C packages/react/docs/examples/note-editor dev` and
`vp -C packages/react/docs/examples/note-editor run test` from the repo root,
and `run test:types` to type-check.

## When to Use

Follow this alongside `../../tutorial/01-your-first-feature.md` to see a
feature's three parts (state, reducer, render) built up in order, and how
`reduce` lets you test a single transition with no React and no async setup.
