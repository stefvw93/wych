import { Action, Command, define, Task } from "@wych/react";
import { Effect, Schema } from "effect";
import { Hits, SearchApi } from "./search-api";

export const Typed = Action("Typed", { query: Schema.String });
const Loaded = Action("Loaded", { hits: Hits });

/** Debounce inside the command: `Command.restart` cancels the sleeping fiber. */
export const searchFeature = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, hits: Hits }),
  action: Action.of([Typed, Loaded]),
}).create({
  initialState: () => ({ query: "", hits: [] }),
  reducer: {
    Typed: ({ query }, { state }) => [
      { ...state, query },
      Command.restart(
        "query",
        Command.effect((dispatch) =>
          Effect.gen(function* () {
            yield* Effect.sleep("300 millis");
            const api = yield* SearchApi;
            const hits = yield* api.hits(query);
            yield* dispatch(Loaded.make({ hits }));
          }),
        ),
      ),
    ],
    Loaded: ({ hits }, { state }) => ({ ...state, hits }),
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed.make({ query: event.target.value }))}
      />
      <ul>
        {state.hits.map((hit) => (
          <li key={hit}>{hit}</li>
        ))}
      </ul>
    </div>
  ),
});

/** Take latest with a task: the default `mode: "latest"` books under `Command.restart`. */
const search = Task("Search", {
  success: Hits,
  onError: Task.message,
  run: (query: string) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query);
    }),
});

const Cleared = Action("Cleared", {});

export const taskSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, results: Task.schema(Hits) }),
  action: Action.of([Typed, Cleared, ...search.actions]),
}).create({
  initialState: () => ({ query: "", results: Task.idle }),
  reducer: {
    Typed: ({ query }, { state }) => Task.start({ ...state, query }, "results", search.run(query)),
    Cleared: (_payload, { state }) => [{ ...state, query: "", results: Task.idle }, search.cancel],
    SearchResolved: ({ value }, { state }) => ({ ...state, results: Task.resolved(value) }),
    SearchRejected: ({ error }, { state }) => ({ ...state, results: Task.rejected(error) }),
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed.make({ query: event.target.value }))}
      />
      <button onClick={() => dispatch(Cleared.make({}))}>clear</button>
      {Task.match(state.results, {
        Idle: () => null,
        Pending: () => <p>Searching</p>,
        Rejected: ({ error }) => <p>{error}</p>,
        Resolved: ({ value }) => (
          <ul>
            {value.map((hit) => (
              <li key={hit}>{hit}</li>
            ))}
          </ul>
        ),
      })}
    </div>
  ),
});

/** `mode: "every"` books with `Command.keyed` and never interrupts. */
const searchEvery = Task("SearchEvery", {
  success: Hits,
  onError: Task.message,
  mode: "every",
  run: (query: string) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query);
    }),
});

export const everySearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ results: Task.schema(Hits) }),
  action: Action.of([Typed, ...searchEvery.actions]),
}).create({
  initialState: () => ({ results: Task.idle }),
  reducer: {
    Typed: ({ query }, { state }) => Task.start(state, "results", searchEvery.run(query)),
    SearchEveryResolved: ({ value }, { state }) => ({
      ...state,
      results: Task.resolved(value),
    }),
    SearchEveryRejected: ({ error }, { state }) => ({
      ...state,
      results: Task.rejected(error),
    }),
  },
  render: () => null,
});

/** Load the next page: `Task.start` takes a thunk that reads the state the handler built. */
const searchPage = Task("SearchPage", {
  success: Hits,
  onError: Task.message,
  run: ({ query, page }: { readonly query: string; readonly page: number }) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query, page);
    }),
});

export const MoreClicked = Action("MoreClicked", {});

export const pagedSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, page: Schema.Number, results: Task.schema(Hits) }),
  action: Action.of([Typed, MoreClicked, ...searchPage.actions]),
}).create({
  initialState: () => ({ query: "", page: 1, results: Task.idle }),
  reducer: {
    Typed: ({ query }, { state }) =>
      Task.start({ ...state, query, page: 1 }, "results", (next) => searchPage.run(next)),
    MoreClicked: (_payload, { state }) =>
      Task.start({ ...state, page: state.page + 1 }, "results", (next) => searchPage.run(next)),
    SearchPageResolved: ({ value }, { state }) => ({ ...state, results: Task.resolved(value) }),
    SearchPageRejected: ({ error }, { state }) => ({ ...state, results: Task.rejected(error) }),
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed.make({ query: event.target.value }))}
      />
      <button onClick={() => dispatch(MoreClicked.make({}))}>more</button>
      {Task.match(state.results, {
        Idle: () => null,
        Pending: () => <p>Loading page {state.page}</p>,
        Rejected: ({ error }) => <p>{error}</p>,
        Resolved: ({ value }) => (
          <ul>
            {value.map((hit) => (
              <li key={hit}>{hit}</li>
            ))}
          </ul>
        ),
      })}
    </div>
  ),
});
