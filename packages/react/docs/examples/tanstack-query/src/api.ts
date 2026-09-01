/**
 * A promise-based notes API, the shape TanStack Query expects. In-memory
 * with a delay, so loading and saving are visible.
 */
export interface Note {
  readonly id: string;
  readonly text: string;
}

const notes = new Map<string, Note>([
  ["n1", { id: "n1", text: "Milk, eggs, bread" }],
  ["n2", { id: "n2", text: "Call the plumber" }],
]);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const fetchNote = async (id: string): Promise<Note> => {
  await delay(400);
  const note = notes.get(id);
  if (note === undefined) throw new Error(`no note ${id}`);
  return note;
};

export const saveNote = async (id: string, text: string): Promise<Note> => {
  await delay(400);
  if (text.trim() === "") throw new Error("a note cannot be empty");
  const note = { id, text };
  notes.set(id, note);
  return note;
};
