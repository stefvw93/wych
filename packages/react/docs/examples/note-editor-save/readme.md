# note-editor-save

## Overview

Extends `note-editor` with a save button backed by an async `Task`.
`notes-api.ts` adds a `NotesApi` service, `note-editor.tsx` adds a `Save`
task and cancel button, and `main.tsx` runs two saves and a cancelled save
against a slow layer, logging the results.

## Problem

Saving over the network needs a pending state, a result, and a way to cancel
a save in flight. Modeling that with a `isSaving` boolean plus an optional
error and an optional result invites states that should not exist together,
like `isSaving: true` next to a stale error.

## Solution

`Task("Save", { success, onError, run })` declares `SaveResolved` and
`SaveRejected` actions and a run function. The state field is a `TaskValue`
built with `Task.schema`, so it is always exactly one of `Idle`, `Pending`,
`Resolved`, or `Rejected`:

```tsx fragment
SaveClicked: (_payload, { state, props }) =>
  Task.start(state, "save", saveNote.run({ id: props.noteId, text: state.text })),
SaveCancelled: (_payload, { state }) => [{ ...state, save: Task.idle }, saveNote.cancel],
```

`render` reads the field with the total `Task.match`, covering all four cases
so there is no missing branch for "pending with an error" or similar.

## How It Works

`notes-api.ts` defines `NotesApi` as a `Context.Service` with one `save`
method, and a default layer that resolves immediately. `runtime.ts` builds
the runtime over that layer. `main.tsx` mounts the editor, then calls
`editor.run` twice against a `slowSave` layer: once with two `SaveClicked`
actions to show a task is take-latest by default, and once with a
`SaveClicked` followed by `SaveCancelled` to show the cancel path leaves no
emitted action and resets to `Idle`.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev`.
Inside this monorepo, run `vp -C packages/react/docs/examples/note-editor-save dev`
from the repo root, and `vp -C packages/react/docs/examples/note-editor-save run test:types`
to type-check.

## When to Use

Follow this alongside `../../tutorial/02-async-work.md` for the second
tutorial step: adding a `Task` to a feature that already has local state, and
proving cancellation with `feature.run` instead of clicking through the UI.
