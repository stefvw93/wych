import { Next } from "@wych/react";
import { createRoot } from "react-dom/client";
import { NoteEditor, TextChanged, editor } from "./note-editor";

const root = createRoot(document.getElementById("root")!);
root.render(<NoteEditor noteId="n1" initialText="Buy milk" />);

// Fold one action without React. Open the console.
const next = editor.reduce(TextChanged.make({ text: "Buy oats" }), {
  state: { text: "Buy milk", dirty: false },
  props: { noteId: "n1", initialText: "Buy milk" },
  hooks: {},
});

console.log(Next.state(next));
// => { text: "Buy oats", dirty: true }
console.log(Next.command(next));
// => undefined
