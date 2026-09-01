# note-list

## Overview

A parent `NoteList` feature that loads notes with a `Task`, mounts one
`NoteEditor` child per note, and listens for each child's `Saved` output
through `onSaved`. `note-list.tsx` also takes `children` and reads a sibling
fragment with `useFeature`. `main.tsx` logs a fold that crosses the output
boundary.

## Problem

A list of editable notes needs a parent that knows what changed, without the
parent reaching into each child's internal state. If a child's save result
re-entered a shared reducer directly, the parent and every child would need
to agree on one action vocabulary.

## Solution

`note-editor.tsx` declares `Saved` with `Action.output` and emits it from
`SaveResolved` with `Command.output`. `note-list.tsx` never handles `Saved` in
its own reducer; it only listens on the JSX boundary:

```tsx fragment
<NoteEditor
  noteId={note.id}
  initialText={note.text}
  onSaved={({ id, revision }) => dispatch(NoteSaved.make({ id, revision }))}
/>
```

The parent turns that callback into its own `NoteSaved` action, which is a
different tag folding into a different reducer. The two vocabularies stay
separate.

## How It Works

`notes-api.ts` adds a `list` method alongside `save`. `note-list.tsx` defines
`List` with a `loadNotes` task that runs on `Mounted`, renders each note as a
`NoteEditor`, and a `LastSaved` fragment that reads `NoteList.useFeature()`
for the most recent save. `props.children` renders as given, since `Children`
is opaque to the reducer. `main.tsx` mounts `<NoteList>` with a child
paragraph, then calls `editor.run` directly on the child feature to show its
`emitted` actions (`SaveResolved`) versus its `outputs` (`Saved`) are two
different lists.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev`.
Inside this monorepo, run `vp -C packages/react/docs/examples/note-list dev`
from the repo root, and `vp -C packages/react/docs/examples/note-list run test:types`
to type-check.

## When to Use

Follow this alongside `../../tutorial/03-composing-features.md` to see a
parent-child feature pair and confirm that outputs cross the boundary once,
never re-entering either reducer.
