import { Effect, Layer } from "effect";
import { Next, Task } from "@wych/react";
import { expect, test } from "vitest";
import { actions, editor, saveNote } from "./note-editor";
import { actions as byHandActions, byHand } from "./note-editor-by-hand";
import { NotesApi } from "./notes-api";

const props = { noteId: "n1", initialText: "Buy milk" };

// Slow enough that the first save is still in flight when the second click lands.
const slowSave = Layer.succeed(NotesApi)({
  save: (note) =>
    Effect.gen(function* () {
      yield* Effect.sleep("50 millis");
      return `${note.id}@2`;
    }),
});

const failingSave = Layer.succeed(NotesApi)({
  save: () => Effect.fail(new Error("offline")),
});

// --- by hand -----------------------------------------------------------------

test("by hand: a second click while saving is ignored", async () => {
  const { emitted, state } = await Effect.runPromise(
    byHand.run([byHandActions.SaveClicked.make(), byHandActions.SaveClicked.make()], {
      props,
      hooks: {},
      layer: slowSave,
    }),
  );

  expect(emitted).toEqual([{ _tag: "Saved", revision: "n1@2" }]);
  expect(state.saving).toBe(false);
  expect(state.dirty).toBe(false);
});

test("by hand: a failure lands in the error field", async () => {
  const { state } = await Effect.runPromise(
    byHand.run([byHandActions.SaveClicked.make()], { props, hooks: {}, layer: failingSave }),
  );

  expect(state.error).toBe("offline");
  expect(state.saving).toBe(false);
});

// --- with Task ---------------------------------------------------------------

test("task: a second click while saving is ignored", async () => {
  const { emitted, state } = await Effect.runPromise(
    editor.run([actions.SaveClicked.make(), actions.SaveClicked.make()], {
      props,
      hooks: {},
      layer: slowSave,
    }),
  );

  expect(emitted).toEqual([{ _tag: "SaveResolved", value: "n1@2" }]);
  expect(state.save).toEqual({ _tag: "Resolved", value: "n1@2" });
  expect(state.dirty).toBe(false);
});

test("task: a settle writes the field, then the handler clears dirty", () => {
  const settled = editor.reduce(saveNote.Resolved.make({ value: "n1@3" }), {
    state: { text: "Buy milk", dirty: true, save: Task.pending },
    props,
    hooks: {},
  });

  expect(Next.state(settled)).toEqual({
    text: "Buy milk",
    dirty: false,
    save: { _tag: "Resolved", value: "n1@3" },
  });
});

test("task: a failure lands in the same field", async () => {
  const { state } = await Effect.runPromise(
    editor.run([actions.SaveClicked.make()], { props, hooks: {}, layer: failingSave }),
  );

  expect(state.save).toEqual({ _tag: "Rejected", error: "offline" });
});

test("task: a cancelled save dispatches nothing and resets to Idle", async () => {
  const { emitted, state } = await Effect.runPromise(
    editor.run([actions.SaveClicked.make(), actions.SaveCancelled.make()], {
      props,
      hooks: {},
      layer: slowSave,
    }),
  );

  expect(emitted).toEqual([]);
  expect(state.save).toEqual({ _tag: "Idle" });
});
