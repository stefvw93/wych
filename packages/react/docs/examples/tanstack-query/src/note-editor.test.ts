import { QueryClient } from "@tanstack/react-query";
import { Next, Task } from "@wych/react";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { fetchNote } from "./api";
import { noteEditor, noteKey, Submitted, Typed } from "./note-editor";
import { Queries } from "./queries";

// Hooks are plain data in a fold, so the read path needs no QueryClientProvider.
const loaded = { text: "Milk, eggs, bread", status: "success" as const };
const props = { noteId: "n1" };

test("HookChanged adopts the fetched text as the draft", () => {
  const next = noteEditor.reduce(
    { _tag: "HookChanged", previous: { text: undefined, status: "pending" } },
    { state: { draft: "", save: Task.idle }, props, hooks: loaded },
  );

  expect(Next.state(next).draft).toBe("Milk, eggs, bread");
  expect(Next.command(next)).toBeUndefined();
});

test("Submitted saves through the service and invalidates the key", async () => {
  // A real QueryClient, no React. Prefetch so there is a cache entry to invalidate.
  const client = new QueryClient();
  await client.prefetchQuery({ queryKey: noteKey("n1"), queryFn: () => fetchNote("n1") });

  const { state, emitted, outputs } = await Effect.runPromise(
    noteEditor.run([Typed.make({ text: "Oat milk" }), Submitted.make({})], {
      props,
      hooks: loaded,
      layer: Layer.succeed(Queries)(client),
    }),
  );

  expect(emitted).toEqual([{ _tag: "SaveResolved", value: "Oat milk" }]);
  expect(outputs).toEqual([{ _tag: "Saved", id: "n1" }]);
  expect(state.save).toEqual({ _tag: "Resolved", value: "Oat milk" });
  expect(client.getQueryState(noteKey("n1"))?.isInvalidated).toBe(true);
});

test("an empty draft rejects and announces nothing", async () => {
  const { state, outputs } = await Effect.runPromise(
    noteEditor.run([Typed.make({ text: "" }), Submitted.make({})], {
      props,
      hooks: loaded,
      layer: Layer.succeed(Queries)(new QueryClient()),
    }),
  );

  expect(state.save).toEqual({ _tag: "Rejected", error: "a note cannot be empty" });
  expect(outputs).toEqual([]);
});
