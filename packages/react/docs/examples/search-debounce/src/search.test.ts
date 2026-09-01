import { Next, Task } from "@wych/react";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { everySearch, taskSearch, Typed } from "./search";
import { SearchApi } from "./search-api";

// A slow stub: the "a" request is still in flight when "ab" arrives.
const slowApi = Layer.succeed(SearchApi)({
  hits: (query) => Effect.sleep("50 millis").pipe(Effect.as([`${query}!`])),
});

const keystrokes = [Typed.make({ query: "a" }), Typed.make({ query: "ab" })];
const options = { props: {}, hooks: {}, layer: slowApi };

// --- one step with reduce ---------------------------------------------------

test("Typed writes Pending and issues the search command", () => {
  const next = taskSearch.reduce(Typed.make({ query: "a" }), {
    state: { query: "", results: Task.idle },
    props: {},
    hooks: {},
  });

  expect(Next.state(next)).toEqual({ query: "a", results: { _tag: "Pending" } });
  expect(Next.command(next)).toBeDefined();
});

// --- a sequence with run ----------------------------------------------------

test("latest: a newer keystroke interrupts the request in flight", async () => {
  const { state, emitted } = await Effect.runPromise(taskSearch.run(keystrokes, options));

  expect(emitted).toEqual([{ _tag: "SearchResolved", value: ["ab!"] }]);
  expect(state).toEqual({ query: "ab", results: { _tag: "Resolved", value: ["ab!"] } });
});

test("every: both requests land, in order", async () => {
  const { state, emitted } = await Effect.runPromise(everySearch.run(keystrokes, options));

  expect(emitted).toEqual([
    { _tag: "SearchEveryResolved", value: ["a!"] },
    { _tag: "SearchEveryResolved", value: ["ab!"] },
  ]);
  expect(state.results).toEqual({ _tag: "Resolved", value: ["ab!"] });
});
