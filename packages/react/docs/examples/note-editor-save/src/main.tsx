import { createRoot } from "react-dom/client";
import { NoteEditor } from "./note-editor";
import { NoteEditorByHand } from "./note-editor-by-hand";

const root = createRoot(document.getElementById("root")!);
root.render(
  <>
    <h2>With Task</h2>
    <NoteEditor noteId="n1" initialText="Buy milk" />
    <h2>By hand</h2>
    <NoteEditorByHand noteId="n2" initialText="Buy oats" />
  </>,
);
