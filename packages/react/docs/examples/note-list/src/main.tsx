import { Effect } from "effect";
import { createRoot } from "react-dom/client";
import { SaveClicked, editor } from "./note-editor";
import { NoteList } from "./note-list";
import { notesApiLayer } from "./notes-api";

const root = createRoot(document.getElementById("root")!);
root.render(
  <NoteList title="Notes">
    <p>Every note saves on its own.</p>
  </NoteList>,
);

// Watch the output cross. Outputs are collected, never folded. Open the console.
const saved = await Effect.runPromise(
  editor.run([SaveClicked.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: notesApiLayer,
  }),
);

console.log(saved.emitted.map((action) => action._tag));
// => ["SaveResolved"]
console.log(saved.outputs.map((output) => output._tag));
// => ["Saved"]
console.log(saved.state.dirty);
// => false
