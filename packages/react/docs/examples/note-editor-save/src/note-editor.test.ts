import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { editor, SaveCancelled, SaveClicked } from "./note-editor";
import { byHand, SaveClicked as SaveClickedByHand } from "./note-editor-by-hand";
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
    byHand.run([SaveClickedByHand.make({}), SaveClickedByHand.make({})], {
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
    byHand.run([SaveClickedByHand.make({})], { props, hooks: {}, layer: failingSave }),
  );

  expect(state.error).toBe("offline");
  expect(state.saving).toBe(false);
});

// --- with Task ---------------------------------------------------------------

test("task: a second click while saving is ignored", async () => {
  const { emitted, state } = await Effect.runPromise(
    editor.run([SaveClicked.make({}), SaveClicked.make({})], { props, hooks: {}, layer: slowSave }),
  );

  expect(emitted).toEqual([{ _tag: "SaveResolved", value: "n1@2" }]);
  expect(state.save).toEqual({ _tag: "Resolved", value: "n1@2" });
});

test("task: a failure lands in the same field", async () => {
  const { state } = await Effect.runPromise(
    editor.run([SaveClicked.make({})], { props, hooks: {}, layer: failingSave }),
  );

  expect(state.save).toEqual({ _tag: "Rejected", error: "offline" });
});

test("task: a cancelled save dispatches nothing and resets to Idle", async () => {
  const { emitted, state } = await Effect.runPromise(
    editor.run([SaveClicked.make({}), SaveCancelled.make({})], {
      props,
      hooks: {},
      layer: slowSave,
    }),
  );

  expect(emitted).toEqual([]);
  expect(state.save).toEqual({ _tag: "Idle" });
});
