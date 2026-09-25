import { Action, Command, define, Task } from "@wych/react";
import { Effect, Schema } from "effect";
import { Hits, SearchApi } from "./search-api";

export const Typed = Action("Typed", { query: Schema.String });
const Loaded = Action("Loaded", { hits: Hits });

/** Debounce inside the command: `Command.restart` cancels the sleeping fiber. */
export const searchFeature = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, hits: Hits }),
  actions: [Typed, Loaded],
}).create({
  initialState: () => ({ query: "", hits: [] }),
  reducer: {
    Typed: ({ query }, { draft }) => {
      draft.query = query;
      return [
        draft,
        Command.restart(
          "query",
          Command.effect((dispatch) =>
            Effect.gen(function* () {
              yield* Effect.sleep("300 millis");
              const api = yield* SearchApi;
              const hits = yield* api.hits(query);
              yield* dispatch(Loaded, { hits });
            }),
          ),
        ),
      ];
    },
    Loaded: ({ hits }, { draft }) => {
      draft.hits = [...hits];
      return draft;
    },
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed, { query: event.target.value })}
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
  run: (query: string) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query);
    }),
});

const Cleared = Action("Cleared");

export const taskSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String }),
  tasks: { results: search },
  actions: [Typed, Cleared],
}).create({
  initialState: () => ({ query: "" }),
  reducer: {
    Typed: ({ query }, { draft, tasks }) => {
      draft.query = query;
      return tasks.results.start(query);
    },
    Cleared: (_payload, { draft, tasks }) => {
      draft.query = "";
      return tasks.results.cancel();
    },
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed, { query: event.target.value })}
      />
      <button onClick={() => dispatch(Cleared)}>clear</button>
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
  mode: "every",
  run: (query: string) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query);
    }),
});

export const everySearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  tasks: { results: searchEvery },
  actions: Typed,
}).create({
  initialState: () => ({}),
  reducer: {
    Typed: ({ query }, { tasks }) => tasks.results.start(query),
  },
  render: () => null,
});

/** Load the next page: the handler writes `page`, then starts the task with the page it wrote. */
const searchPage = Task("SearchPage", {
  success: Hits,
  run: ({ query, page }: { readonly query: string; readonly page: number }) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query, page);
    }),
});

export const MoreClicked = Action("MoreClicked");

export const pagedSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, page: Schema.Number }),
  tasks: { results: searchPage },
  actions: [Typed, MoreClicked],
}).create({
  initialState: () => ({ query: "", page: 1 }),
  reducer: {
    Typed: ({ query }, { draft, tasks }) => {
      draft.query = query;
      draft.page = 1;
      return tasks.results.start({ query, page: 1 });
    },
    MoreClicked: (_payload, { draft, tasks }) => {
      draft.page += 1;
      return tasks.results.start({ query: draft.query, page: draft.page });
    },
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed, { query: event.target.value })}
      />
      <button onClick={() => dispatch(MoreClicked)}>more</button>
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
