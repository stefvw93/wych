# note-editor

## Overview

A three-file note editor: `runtime.ts` builds the runtime, `note-editor.tsx`
declares and creates the feature with the split-declaration form
(`Editor.initialState`, `Editor.reducer`, `Editor.render`), and `main.tsx`
mounts it and folds one action without React.

## Problem

A text field with a dirty flag and a revert button needs local state, but
`useState` ties that state to the component instance. It cannot be tested
without mounting, and there is no way to reuse the same state machine outside
React.

## Solution

`note-editor.tsx` defines the feature once with `define`, then builds each
piece separately: `Editor.initialState`, `Editor.reducer`, and `Editor.render`.
The `TextChanged` handler recomputes `dirty` by comparing against
`props.initialText`, and `Reverted` restores it:

```tsx fragment
const reducer = Editor.reducer({
  TextChanged: ({ text }, { props }) => ({ text, dirty: text !== props.initialText }),
  Reverted: (_payload, { props }) => ({ text: props.initialText, dirty: false }),
});
```

`dispatch` takes the full tagged message, either `TextChanged.make({ text })`
or the bare `{ _tag: "Reverted" }` object.

## How It Works

`runtime.ts` calls `createRuntime(Layer.empty)` and exports `component`, which
`note-editor.tsx` uses to build `NoteEditor`. `main.tsx` mounts
`<NoteEditor noteId="n1" initialText="Buy milk" />`, then calls
`editor.reduce` directly with a `TextChanged` action and a hand-written
`state`/`props` snapshot, logging the next state and command with `Next.state`
and `Next.command`.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev`.
Inside this monorepo, run `vp -C packages/react/docs/examples/note-editor dev`
from the repo root, and `vp -C packages/react/docs/examples/note-editor run test:types`
to type-check.

## When to Use

Follow this alongside `../../tutorial/01-your-first-feature.md` to see a
feature's three parts (state, reducer, render) built up in order, and how
`reduce` lets you test a single transition with no React and no async setup.
