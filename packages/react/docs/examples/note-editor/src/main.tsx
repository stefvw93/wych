import { createRoot } from "react-dom/client";
import { NoteEditor } from "./note-editor";

const root = createRoot(document.getElementById("root")!);
root.render(<NoteEditor noteId="n1" initialText="Buy milk" />);
