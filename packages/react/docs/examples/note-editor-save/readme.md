# note-editor-save

## Overview

Extends `note-editor` with a save button, twice. `note-editor-by-hand.tsx`
writes the save as a bare `Command.effect` with two booleans for state.
`note-editor.tsx` writes the same save with `Task`. `main.tsx` mounts both,
and `note-editor.test.ts` runs the same sequences through each.

## Problem

The editor holds text and nothing else. Saving it needs a service to call, a
way to run the call, and somewhere to put the outcome. Every save button then
hits the same two problems. Two clicks send two requests: a disabled button
stops a mouse, and a keyboard shortcut or a retry loop does not read the
button. And `saving` plus `error` are two fields that can disagree, with no
place for the revision the save returned. A save has four outcomes, and two
booleans cannot spell four cases.

## Solution

`Task("Save", { success, onError, run })` declares `SaveResolved` and
`SaveRejected`, the command, and the failure mapping. The state field is a
`TaskValue` built with `Task.schema`, so it is always exactly one of `Idle`,
`Pending`, `Resolved`, or `Rejected`. The double-click guard reads that
field:

```tsx fragment
SaveClicked: (_payload, { state, props }) =>
  Task.isPending(state.save)
    ? state
    : Task.start(state, "save", saveNote.run({ id: props.noteId, text: state.text })),
SaveCancelled: (_payload, { state }) => [{ ...state, save: Task.idle }, saveNote.cancel],
```

`render` reads the field with `Task.match`, which is exhaustive: a missing
case does not compile, and "pending with an error" is no longer a case at
all.

## How It Works

`notes-api.ts` defines `NotesApi` as a `Context.Service` with one `save`
method, and a default layer that resolves immediately. `runtime.ts` builds
the runtime over that layer. `note-editor-by-hand.tsx` returns
`Command.effect` from `SaveClicked`, maps every failure to `SaveFailed`
with `catchCause`, and guards on `state.saving`. `note-editor.tsx` does the
same with `Task.start`, `saveNote.run` and `Task.isPending`.

`note-editor.test.ts` folds each feature with `feature.run` against a slow
layer and a failing layer: two clicks produce one save in both, a failure
lands in `error` by hand and in `save` with `Task`, and `SaveCancelled`
leaves the task feature at `Idle` with nothing emitted.

Run it standalone or in StackBlitz: `npm install`, then `npm run dev` for
the app and `npm test` for the tests. Inside this monorepo, run
`vp -C packages/react/docs/examples/note-editor-save dev` and
`vp -C packages/react/docs/examples/note-editor-save run test` from the repo
root, and `run test:types` to type-check.

## When to Use

Follow this alongside `../../tutorial/02-async-work.md` for the second
tutorial step: writing async work as a `Command` first, then letting `Task`
fold the pending write, the result actions and the failure mapping into one
field, and proving both with `feature.run` instead of clicking through the
UI.
