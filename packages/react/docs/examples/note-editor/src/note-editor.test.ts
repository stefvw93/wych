import { Next } from "@wych/react";
import { expect, test } from "vitest";
import { actions, editor } from "./note-editor";

// No DOM, no Effect runtime: `reduce` is the reducer as one function.
test("typing marks the note dirty", () => {
  const next = editor.reduce(actions.TextChanged.make({ text: "Buy oats" }), {
    state: { text: "Buy milk", dirty: false },
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
  });

  expect(Next.state(next)).toEqual({ text: "Buy oats", dirty: true });
  expect(Next.command(next)).toBeUndefined();
});
