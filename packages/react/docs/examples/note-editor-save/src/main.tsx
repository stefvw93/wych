import { Effect, Layer } from "effect";
import { createRoot } from "react-dom/client";
import { NoteEditor, SaveCancelled, SaveClicked, editor } from "./note-editor";
import { NotesApi } from "./notes-api";

const root = createRoot(document.getElementById("root")!);
root.render(<NoteEditor noteId="n1" initialText="Buy milk" />);

// Two saves, one result. A task is take-latest by default. Open the console.
const slowSave = Layer.succeed(NotesApi)({
  save: (note) => Effect.as(Effect.sleep("50 millis"), `${note.id}@2`),
});

const twoSaves = await Effect.runPromise(
  editor.run([SaveClicked.make({}), SaveClicked.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: slowSave,
  }),
);

console.log(twoSaves.emitted.map((action) => action._tag));
// => ["SaveResolved"]
console.log(twoSaves.state.save);
// => { _tag: "Resolved", value: "n1@2" }

// Cancel a save in flight.
const cancelled = await Effect.runPromise(
  editor.run([SaveClicked.make({}), SaveCancelled.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: slowSave,
  }),
);

console.log(cancelled.emitted);
// => []
console.log(cancelled.state.save);
// => { _tag: "Idle" }
