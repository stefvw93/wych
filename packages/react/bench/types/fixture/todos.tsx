// The bench's main fixture: a todo board in the shape of a mid-sized Wych
// feature. Ten actions in an `as const` array, four slot tasks (a
// `flatMap`, an `Effect.gen`, a `void` input and an `Effect.all`), a hook,
// a `Children` prop, and handlers that mix draft writes, spreads and task
// starts. `/*@name*/` comments mark the positions lsp-bench.mjs queries.
import { Cause, Effect, Schema } from "effect";
import { Action, Children, Task, createRuntime, define } from "@wych/react";
import type { Draft } from "@wych/react";
import { Appearance, Mode, TodoFilter, TodoPage } from "./schemas";
import { AppearanceApi, AttachmentStore, TodoApi } from "./services";

const /*@control*/ useBoardTheme = () => ({ setMode: (_mode: "dark" | "light" | "system") => {} });

const View = Schema.Literals(["list", "board", "calendar"]);
const Contrast = Schema.Number.check(Schema.isBetween({ minimum: -1, maximum: 1 }));

const Props = Schema.Struct({
  children: Schema.optionalKey(Children),
});

const /*@chainTask*/ LoadTodos = Task("LoadTodos", {
    success: TodoPage,
    onError: (cause) => {
      const error: unknown = Cause.squash(cause);
      if (!(error instanceof Error)) return String(error);
      return error.message !== "" ? error.message : error.name;
    },
    run: (filter: typeof TodoFilter.Type) => Effect.flatMap(TodoApi, (api) => api.search(filter)),
  });

const RecentAttachments = Task("RecentAttachments", {
  success: Schema.Array(Schema.Unknown),
  // A task whose `run` takes nothing, typed the way apps write it.
  // oxlint-disable-next-line no-unused-vars
  run: (_: void) => Effect.flatMap(AttachmentStore, (store) => store.recent),
});

type AppearanceInput = Pick<BoardState, "cover" | "mode" | "contrast">;

const /*@chainTaskGen*/ DeriveAppearance = Task("DeriveAppearance", {
    success: Appearance,
    run: (input: AppearanceInput) =>
      Effect.gen(function* () {
        if (!input.cover) {
          return yield* Effect.fail(new Error("No cover selected"));
        }
        const api = yield* AppearanceApi;
        return yield* api.derive(input.cover, { mode: input.mode, contrast: input.contrast });
      }),
  });

const PublishAppearance = Task("PublishAppearance", {
  success: Schema.Void,
  run: ({ cover, appearance }: { readonly cover: URL; readonly appearance: Appearance }) =>
    Effect.gen(function* () {
      const api = yield* AppearanceApi;
      yield* Effect.all([api.uploadCover(cover), api.publish(appearance)], {
        concurrency: "unbounded",
      });
      yield* api.activate("board");
    }),
});

const /*@chainState*/ BoardState = Schema.Struct({
    view: View,
    cover: Schema.UndefinedOr(Schema.URLFromString).pipe(Schema.optional),
    filter: TodoFilter,
    mode: Mode,
    contrast: Contrast,
  });
type BoardState = typeof BoardState.Type;

export const CoverPicked = Action("CoverPicked", { url: Schema.URLFromString });
export const PageRequested = Action("PageRequested", { page: Schema.Number });
export const ContrastCommitted = Action("ContrastCommitted", { contrast: Contrast });
const Searched = Action("Searched", TodoFilter.fields);
export const ContrastChanged = Action("ContrastChanged", { contrast: Contrast });
const ViewChanged = Action("ViewChanged", { view: View });
export const ModeChanged = Action("ModeChanged", { mode: Mode });
export const ColumnsChanged = Action("ColumnsChanged", { columns: Schema.Number });
const FilterEdited = Action("FilterEdited", TodoFilter.fields);
export const AppearancePublished = Action("AppearancePublished", {});

const /*@chainActions*/ BoardActions = [
    AppearancePublished,
    ContrastCommitted,
    CoverPicked,
    PageRequested,
    Searched,
    ContrastChanged,
    ViewChanged,
    ModeChanged,
    ColumnsChanged,
    FilterEdited,
  ] as const;

const /*@chainDefine*/ Board = define({
    props: Props,
    state: BoardState,
    tasks: {
      todos: LoadTodos,
      attachments: RecentAttachments,
      appearance: DeriveAppearance,
      publish: PublishAppearance,
    },
    actions: BoardActions,
    useUnsafeHooks() {
      const theme = useBoardTheme();
      return { theme };
    },
  });

const initialState = Board.initialState(() => ({
  view: "list" as const,
  mode: "dark",
  contrast: 0,
  filter: {
    page: 1,
    tags: ["inbox"],
    status: "open",
    sort: "due",
    order: "asc",
  },
}));

const /*@chainReducer*/ reducer = Board.reducer({
    /*@newKey*/
    Mounted: (_, { state, draft, tasks }) =>
      state.view === "board" ? tasks.todos.start(state.filter) : draft,

    ContrastChanged: ({ contrast }, { draft }) => {
      draft.contrast = contrast;
      return draft;
    },

    ContrastCommitted: ({ contrast }, { state, draft, tasks }) => {
      draft.contrast = contrast;
      return tasks.appearance.start({ ...state, contrast });
    },

    ViewChanged: ({ view }, { state, draft, tasks }) => {
      draft.view = view;

      if (view === "calendar") {
        return tasks.attachments.start();
      }

      if (view === "board") {
        return tasks.todos.start(state.filter);
      }

      return draft;
    },

    /*@hoverKey*/ ModeChanged: (
      { mode },
      { state, /*@hoverDraft*/ draft, /*@hoverTasks*/ tasks, hooks },
    ) => {
      hooks.theme.setMode(mode);
      /*@draftDot*/ draft.mode = mode;
      return /*@tasksDot*/ tasks.appearance.start({ ...state, mode });
    },

    PageRequested: (payload, { state, draft, tasks }) => {
      const filter = {
        ...state.filter,
        page: payload.page || state.filter.page || 1,
      };

      draft.filter.page = filter.page;
      return tasks.todos.start(filter);
    },

    CoverPicked: ({ url }, { state, draft, tasks }) => {
      if (url.href === state.cover?.href) return draft;

      draft.cover = url;
      return tasks.appearance.start({ ...state, cover: url });
    },

    ColumnsChanged: (_payload, { state }) => ({ ...state }),

    FilterEdited: (filter, { draft }) => {
      draft.filter = filter as Draft<typeof filter>;
      return draft;
    },

    AppearancePublished: (_, { state, draft, tasks }) =>
      Task.isResolved(state.appearance) && state.cover
        ? tasks.publish.start({
            cover: state.cover,
            appearance: state.appearance.value,
          })
        : draft,

    Searched: (payload, { tasks }) => tasks.todos.start(payload),
  });

const render = Board.render(({ state, dispatch }) => (
  <div>
    <button onClick={() => dispatch(ViewChanged.make({ view: "board" }))}>{state.view}</button>
    {Task.isPending(state.todos) ? "loading" : null}
  </div>
));

const { component } = createRuntime(
  // The services are signatures; only their types are read.
  undefined as never,
);

export const /*@chainComponent*/ TodoBoard = component(
    Board.create({ initialState, reducer, render }),
    { name: "TodoBoard" },
  );
