import { Context, Effect, Layer, Option, Schema } from "effect";
import { expect, test } from "tstyche";
import { Task, type TaskValue } from "../utils/task";
import { Action, Command, define, Next, type ServicesOf } from "../lib";
import type { Draft } from "../draft";

const Clicked = Action("Clicked", {});
const Props = Schema.Struct({});

class Api extends Context.Service<Api, { readonly load: Effect.Effect<string> }>()("Api") {}

type SearchAction =
  | { readonly _tag: "SearchResolved"; readonly value: string }
  | { readonly _tag: "SearchRejected"; readonly error: string };

type LoadAction =
  | { readonly _tag: "LoadResolved"; readonly value: string }
  | { readonly _tag: "LoadRejected"; readonly error: string };

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

test("an operation owns the work and nothing state-shaped", () => {
  const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });

  expect(search).type.not.toHaveProperty("field");
  expect(search).type.not.toHaveProperty("initial");
  expect(search).type.not.toHaveProperty("handlers");
  expect(search).type.not.toHaveProperty("idle");
  expect(search).type.not.toHaveProperty("start");
  expect(search).type.not.toHaveProperty("match");
  expect(search).type.not.toHaveProperty("get");
  expect(search).type.not.toHaveProperty("reset");
});

test("a lower-case name is rejected, the way an action tag is", () => {
  // The name is the tag prefix, so it has to be capitalised.
  expect(Task).type.not.toBeCallableWith("search", {
    success: Schema.String,
    onError: Task.errorMessage,
  });
});

test("take-first is a mode, beside latest and every", () => {
  expect(Task).type.toBeCallableWith("Search", { success: Schema.String, mode: "first" });
  expect(Task).type.not.toBeCallableWith("Search", { success: Schema.String, mode: "last" });
});

test("`Resolved` and `Rejected` are the two message schemas, by name", () => {
  const search = Task("Search", { success: Schema.Number });
  expect(search.Resolved.make({ value: 1 })).type.toBe<{
    readonly _tag: "SearchResolved";
    readonly value: number;
  }>();
  expect(search.Rejected.make({ error: "no" })).type.toBe<{
    readonly _tag: "SearchRejected";
    readonly error: string;
  }>();
  expect(search.Resolved).type.toBe<(typeof search.actions)[0]>();
});

// ---------------------------------------------------------------------------
// Bound vs unbound `run`
// ---------------------------------------------------------------------------

test("declaring `run` makes the operation's `run` take its input, and only its input", () => {
  const search = Task("Search", {
    success: Schema.String,
    onError: Task.errorMessage,
    run: (query: string) =>
      Effect.map(
        Effect.flatMap(Api, (api) => api.load),
        (v) => `${v}${query}`,
      ),
  });

  expect(search.run("query")).type.toBe<Command<SearchAction, Api>>();

  // The effect form is gone: a bound operation owns its work.
  expect(search.run).type.not.toBeCallableWith(Effect.succeed("query"));
});

test("a `run` that takes no input makes the operation's `run` callable with nothing", () => {
  const load = Task("Load", {
    success: Schema.String,
    onError: Task.errorMessage,
    run: () => Effect.flatMap(Api, (api) => api.load),
  });

  expect(load.run()).type.toBe<Command<LoadAction, Api>>();

  // Still bound: neither an input nor an effect is accepted.
  expect(load.run).type.not.toBeCallableWith("query");
  expect(load.run).type.not.toBeCallableWith(Effect.succeed("ok"));

  const typed = Task("Load", {
    success: Schema.String,
    failure: Schema.Number,
    onError: () => 404,
    run: () => Effect.succeed("ok"),
  });

  expect(typed.run()).type.toBe<
    Command<
      | { readonly _tag: "LoadResolved"; readonly value: string }
      | { readonly _tag: "LoadRejected"; readonly error: number },
      never
    >
  >();
});

test("without `run`, it takes the effect and carries its services to `ServicesOf`", () => {
  const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });
  const state = { search: Task.idle };

  const reducer = {
    Clicked: (_action: { readonly _tag: "Clicked" }, snapshot: { readonly state: typeof state }) =>
      [
        { ...snapshot.state, search: Task.pending },
        search.run(Effect.flatMap(Api, (api) => api.load)),
      ] as const,
  };

  expect<ServicesOf<typeof reducer>>().type.toBe<Api>();

  // The input form is gone: an unbound operation has nothing to apply.
  expect(search.run).type.not.toBeCallableWith("query");
});

// ---------------------------------------------------------------------------
// Constructors and the schema
// ---------------------------------------------------------------------------

test("the constructors are assignable to the field they fill", () => {
  const State = Schema.Struct({ search: Task.schema(Schema.String) });
  type State = typeof State.Type;

  expect<State["search"]>().type.toBe<
    | { readonly _tag: "Idle" }
    | { readonly _tag: "Pending" }
    | { readonly _tag: "Resolved"; readonly value: string }
    | { readonly _tag: "Rejected"; readonly error: string }
  >();

  expect(Task.idle).type.toBeAssignableTo<State["search"]>();
  expect(Task.pending).type.toBeAssignableTo<State["search"]>();
  expect(Task.resolved("v")).type.toBeAssignableTo<State["search"]>();
  expect(Task.rejected("e")).type.toBeAssignableTo<State["search"]>();

  // The success type is not erased: a number does not fill a string field.
  expect(Task.resolved(1)).type.not.toBeAssignableTo<State["search"]>();
});

test("an explicit failure schema types both `onError` and the field", () => {
  const Failure = Schema.Struct({ status: Schema.Number });

  const search = Task("Search", {
    success: Schema.String,
    failure: Failure,
    onError: (): { readonly status: number } => ({ status: 500 }),
  });

  expect(search.run).type.toBeCallableWith(Effect.succeed("ok"));

  const State = Schema.Struct({ search: Task.schema(Schema.String, Failure) });
  expect<(typeof State.Type)["search"]>().type.toBe<
    | { readonly _tag: "Idle" }
    | { readonly _tag: "Pending" }
    | { readonly _tag: "Resolved"; readonly value: string }
    | { readonly _tag: "Rejected"; readonly error: { readonly status: number } }
  >();

  // `op.schema` is that same field, built from the operation's own schemas.
  expect<(typeof search.schema)["Type"]>().type.toBe<(typeof State.Type)["search"]>();
});

test("`onError` is optional without `failure`, and required with one", () => {
  const plain = Task("Plain", { success: Schema.String });
  expect<(typeof plain.schema)["Type"]>().type.toBe<TaskValue<string, string>>();

  const bound = Task("Bound", {
    success: Schema.String,
    run: (id: number) => Effect.succeed(`${id}`),
  });
  expect(bound.run).type.toBeCallableWith(1);
  expect(bound.run).type.not.toBeCallableWith();

  // Zero-input `run` without `onError` still pins `Input` to `void`.
  const nullary = Task("Nullary", { success: Schema.String, run: () => Effect.succeed("x") });
  expect(nullary.run).type.toBeCallableWith();

  // A declared `failure` is a shape the default mapping cannot produce.
  expect(Task).type.not.toBeCallableWith("Typed", {
    success: Schema.String,
    failure: Schema.Struct({ status: Schema.Number }),
  });
  // Even `Schema.String`, when declared: declaring it is the decision.
  expect(Task).type.not.toBeCallableWith("Typed", {
    success: Schema.String,
    failure: Schema.String,
  });
  expect(Task).type.not.toBeCallableWith("Typed", {
    success: Schema.String,
    failure: Schema.String,
    run: () => Effect.succeed("x"),
  });
});

// ---------------------------------------------------------------------------
// match
// ---------------------------------------------------------------------------

test("`match` is total — a missing arm does not compile", () => {
  const State = Schema.Struct({ search: Task.schema(Schema.String) });
  const state: typeof State.Type = { search: Task.idle };

  expect(
    Task.match(state.search, {
      Idle: () => 0,
      Pending: () => 1,
      Resolved: (resolved) => resolved.value.length,
      Rejected: (rejected) => rejected.error.length,
    }),
  ).type.toBe<number>();

  expect(Task.match).type.not.toBeCallableWith(state.search, {
    Idle: () => 0,
    Pending: () => 1,
    Resolved: (resolved: { readonly value: string }) => resolved.value.length,
  });
});

test("the partial reads are typed by the field, and the guards narrow it", () => {
  const State = Schema.Struct({ search: Task.schema(Schema.String, Schema.Number) });
  const state: typeof State.Type = { search: Task.idle };

  expect(Task.value(state.search)).type.toBe<Option.Option<string>>();
  expect(Task.error(state.search)).type.toBe<Option.Option<number>>();
  expect(Task.getOrElse(state.search, () => null)).type.toBe<string | null>();

  if (Task.isResolved(state.search)) {
    expect(state.search.value).type.toBe<string>();
  }
  if (Task.isRejected(state.search)) {
    expect(state.search.error).type.toBe<number>();
  }
  if (Task.isPending(state.search)) {
    expect(state.search).type.toBe<{ readonly _tag: "Pending" }>();
  }
});

// ---------------------------------------------------------------------------
// Announced
// ---------------------------------------------------------------------------

test("an announced operation is the same shape — only the channel differs", () => {
  const search = Task.output("Search", { success: Schema.String, onError: Task.errorMessage });

  expect(search.run(Effect.succeed("ok"))).type.toBe<Command<SearchAction, never>>();
  expect(search.cancel).type.toBe<Command<SearchAction, never>>();

  // An output has no reducer handler, so there is nothing to fold it into.
  expect(search).type.not.toHaveProperty("into");
});

// ---------------------------------------------------------------------------
// into
// ---------------------------------------------------------------------------

test("into(key) spreads into a reducer, keeps it exhaustive, and asks for no service", () => {
  const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });
  const State = Schema.Struct({ colorValue: Schema.String, search: Task.schema(Schema.String) });
  const F = define({ props: Props, state: State, actions: [Clicked, ...search.actions] });

  const reducer = F.reducer({
    Clicked: (_a, { state }) => Task.start(state, "search", search.run(Effect.succeed("ok"))),
    ...search.into("search"),
  });

  expect<ServicesOf<typeof reducer>>().type.toBe<never>();
  expect(
    F.create({
      initialState: () => ({ colorValue: "#000", search: Task.idle }),
      reducer,
      render: () => null,
    }),
  ).type.not.toBe<never>();
});

test("into rejects a key that is not a TaskValue field of the operation's own types", () => {
  const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });
  const State = Schema.Struct({
    colorValue: Schema.String,
    count: Task.schema(Schema.Number),
    search: Task.schema(Schema.String),
  });
  const F = define({ props: Props, state: State, actions: [Clicked, ...search.actions] });
  const Clicked_ = (_a: {}, { state }: { readonly state: typeof State.Type }) => state;

  // Not a TaskValue field.
  expect(F.reducer).type.not.toBeCallableWith({ Clicked: Clicked_, ...search.into("colorValue") });
  // Not a field at all.
  expect(F.reducer).type.not.toBeCallableWith({ Clicked: Clicked_, ...search.into("missing") });
  // A TaskValue field of another success type.
  expect(F.reducer).type.not.toBeCallableWith({ Clicked: Clicked_, ...search.into("count") });
  // The matching field, for contrast.
  expect(F.reducer).type.toBeCallableWith({ Clicked: Clicked_, ...search.into("search") });
});

test("into addresses an optional field, as Task.start does", () => {
  const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });
  const State = Schema.Struct({ search: Schema.optional(Task.schema(Schema.String)) });
  const F = define({ props: Props, state: State, actions: [Clicked, ...search.actions] });

  expect(F.reducer).type.toBeCallableWith({
    Clicked: (_a: {}, { state }: { readonly state: typeof State.Type }) => state,
    ...search.into("search"),
  });
});

test("an explicit handler after the spread wins, typed by the action's payload", () => {
  const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });
  const State = Schema.Struct({ first: Schema.String, search: Task.schema(Schema.String) });
  const F = define({ props: Props, state: State, actions: [Clicked, ...search.actions] });

  F.reducer({
    Clicked: (_a, { state }) => state,
    ...search.into("search"),
    SearchResolved: ({ value }, { state }) => {
      expect(value).type.toBe<string>();
      return { ...state, first: value, search: Task.resolved(value) };
    },
  });
});

test("`Task.start` takes a lazy command, handed the state with `Pending` written", () => {
  const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });
  type State = { readonly q: string; readonly search: TaskValue<string, string> };
  const state = { q: "x", search: Task.idle } as State;

  const next = Task.start(state, "search", (written) => {
    expect(written).type.toBe<State>();
    return search.run(Effect.succeed(written.q));
  });

  expect(next[0]).type.toBe<State>();
  expect(Next.command(next)).type.toBeAssignableTo<Command<SearchAction> | undefined>();
});

// ---------------------------------------------------------------------------
// resolvedInto / rejectedInto
// ---------------------------------------------------------------------------

const settle = (() => {
  const search = Task("Search", { success: Schema.Array(Schema.String) });
  const Picked = Action("Picked", { id: Schema.String });
  const State = Schema.Struct({
    selected: Schema.String,
    results: search.schema,
    n: Schema.Number,
  });
  const F = define({
    props: Schema.Struct({ id: Schema.String }),
    state: State,
    actions: [Clicked, Picked, search],
  });
  const init = () => ({ selected: "", results: Task.idle, n: 0 });
  return { search, State, F, init };
})();

test("`resolvedInto`'s follow-up is typed by the feature, in its key's position", () => {
  const { search, State, F, init } = settle;
  F.create({
    initialState: init,
    render: () => null,
    reducer: {
      Clicked: (_a, s) => s.state,
      Picked: (_a, s) => s.state,
      ...search.into("results"),
      SearchResolved: search.resolvedInto("results", (value, snapshot) => {
        expect(value).type.toBe<ReadonlyArray<string>>();
        expect(snapshot.props).type.toBe<{ readonly id: string }>();
        expect(snapshot.draft.selected).type.toBe<string>();
        snapshot.draft.selected = value[0] ?? "";
        return [
          snapshot.draft,
          Command.effect((dispatch) => dispatch({ _tag: "Picked", id: "x" })),
        ];
      }),
    },
  });

  F.create({
    initialState: init,
    render: () => null,
    reducer: {
      Clicked: (_a, s) => s.state,
      Picked: (_a, s) => s.state,
      ...search.into("results"),
      SearchResolved: search.resolvedInto("results", (_v, s) => [
        s.draft,
        // @ts-expect-error is not assignable
        Command.effect((dispatch) => dispatch({ _tag: "Nope" })),
      ]),
    },
  });

  expect<(typeof State.Type)["results"]>().type.toBe<TaskValue<ReadonlyArray<string>, string>>();
});

test("both sides by hand, with no `into` spread", () => {
  const { search, F } = settle;
  F.reducer({
    Clicked: (_a, s) => s.state,
    Picked: (_a, s) => s.state,
    SearchResolved: search.resolvedInto("results", (_v, s) => s.draft),
    SearchRejected: search.rejectedInto("results", (error, snapshot) => {
      expect(error).type.toBe<string>();
      snapshot.draft.n += 1;
      return snapshot.draft;
    }),
  });
});

test("`R` from a follow-up's command reaches `ServicesOf`, and none leaks otherwise", () => {
  const { search, F } = settle;
  const withApi = F.reducer({
    Clicked: (_a, s) => s.state,
    Picked: (_a, s) => s.state,
    ...search.into("results"),
    SearchResolved: search.resolvedInto("results", (_v, s) => [
      s.draft,
      Command.effect(() => Effect.flatMap(Api, (api) => api.load)),
    ]),
  });
  expect<ServicesOf<typeof withApi>>().type.toBe<Api>();

  const quiet = F.reducer({
    Clicked: (_a, s) => s.state,
    Picked: (_a, s) => s.state,
    ...search.into("results"),
    SearchRejected: search.rejectedInto("results", (_e, s) => s.draft),
  });
  expect<ServicesOf<typeof quiet>>().type.toBe<never>();
});

test("the key is checked, and an excess state key is still reported", () => {
  const { search, F } = settle;
  // `selected` is a string field, so the snapshot `resolvedInto` asks for is
  // one no reducer can hand it. The control with `results` is what makes the
  // rejection about the key.
  expect(F.reducer).type.toBeCallableWith({
    Clicked: (_a: unknown, s: { readonly state: typeof settle.State.Type }) => s.state,
    Picked: (_a: unknown, s: { readonly state: typeof settle.State.Type }) => s.state,
    ...search.into("results"),
    SearchResolved: search.resolvedInto("results", (_v, s) => s.state),
  });
  expect(F.reducer).type.not.toBeCallableWith({
    Clicked: (_a: unknown, s: { readonly state: typeof settle.State.Type }) => s.state,
    Picked: (_a: unknown, s: { readonly state: typeof settle.State.Type }) => s.state,
    ...search.into("results"),
    SearchResolved: search.resolvedInto("selected", (_v, s) => s.state),
  });
  F.reducer({
    Clicked: (_a, s) => s.state,
    Picked: (_a, s) => s.state,
    ...search.into("results"),
    // @ts-expect-error state has no property bogus
    SearchResolved: search.resolvedInto("results", (_v, s) => ({ ...s.state, bogus: 1 })),
  });
});

test("an announced operation has no `resolvedInto`", () => {
  const announced = Task.output("Announced", { success: Schema.String });
  expect(announced).type.not.toHaveProperty("resolvedInto");
  expect(announced).type.not.toHaveProperty("rejectedInto");
});

// ---------------------------------------------------------------------------
// The `tasks` slot
// ---------------------------------------------------------------------------

const slot = (() => {
  const saveNote = Task("Save", {
    success: Schema.Number,
    run: (note: { readonly id: string; readonly text: string }) =>
      Effect.map(
        Effect.flatMap(Api, (api) => api.load),
        (loaded) => loaded.length + note.text.length,
      ),
  });
  const loose = Task("Loose", { success: Schema.String });
  const actions = Action({ SaveClicked: {}, Cancelled: {}, Typed: { text: Schema.String } });
  const Saved = Action.output("Saved", { revision: Schema.Number });
  const props = Schema.Struct({ noteId: Schema.String });
  const state = Schema.Struct({ text: Schema.String, dirty: Schema.Boolean });
  const Editor = define({
    props,
    state,
    tasks: { save: saveNote, loose },
    actions,
    outputs: Saved,
  });
  return { saveNote, loose, actions, Saved, props, state, Editor };
})();

type EditorState = {
  readonly text: string;
  readonly dirty: boolean;
  readonly save: TaskValue<number, string>;
  readonly loose: TaskValue<string, string>;
};

test("each key adds its field to `State`, and `initialState` leaves the fields out", () => {
  const { Editor } = slot;
  const feature = Editor.create({
    initialState: (props) => ({ text: props.noteId, dirty: false }),
    reducer: {
      SaveClicked: (_p, { state }) => state,
      Cancelled: (_p, { state }) => state,
      Typed: (_p, { state }) => state,
    },
    render: ({ state }) => {
      expect(state).type.toBe<EditorState>();
      return null;
    },
  });
  expect(feature.reduce).type.toBeCallableWith(
    { _tag: "Typed", text: "x" },
    {
      props: { noteId: "n" },
      hooks: {},
      state: { text: "", dirty: false, save: Task.idle, loose: Task.idle },
    },
  );
  expect(Editor.initialState).type.toBeCallableWith(() => ({ text: "", dirty: false }));
});

test("the settle keys are optional, and a written one is typed and still checked", () => {
  const { Editor, Saved } = slot;
  Editor.create({
    initialState: () => ({ text: "", dirty: false }),
    render: () => null,
    reducer: {
      SaveClicked: (_p, { state }) => state,
      Cancelled: (_p, { state }) => state,
      Typed: (_p, { state }) => state,
      SaveResolved: ({ value }, { draft, state }) => {
        expect(value).type.toBe<number>();
        expect(state.save).type.toBe<TaskValue<number, string>>();
        expect(draft.save).type.toBe<Draft<TaskValue<number, string>>>();
        draft.dirty = false;
        return [draft, Command.output(Saved, { revision: value })];
      },
      LooseRejected: ({ error }, { state }) => {
        expect(error).type.toBe<string>();
        return state;
      },
    },
  });

  Editor.reducer({
    SaveClicked: (_p, { state }) => state,
    Cancelled: (_p, { state }) => state,
    Typed: (_p, { state }) => state,
    // @ts-expect-error state has no property bogus
    LooseRejected: ({ error }, { state }) => ({ ...state, bogus: error }),
  });

  // A declared action is still required.
  // @ts-expect-error Property 'Typed' is missing
  Editor.reducer({
    SaveClicked: (_p, { state }) => state,
    Cancelled: (_p, { state }) => state,
  });
});

test("`tasks.<key>.start` takes the operation's input, and its `R` reaches `ServicesOf`", () => {
  const { Editor } = slot;
  const reducer = Editor.reducer({
    SaveClicked: (_p, { state, props, tasks }) =>
      tasks.save.start({ id: props.noteId, text: state.text }),
    Cancelled: (_p, { tasks }) => tasks.save.cancel(),
    Typed: ({ text }, { draft }) => {
      draft.text = text;
      return draft;
    },
  });
  expect<ServicesOf<typeof reducer>>().type.toBe<Api>();

  const feature = Editor.create({
    initialState: () => ({ text: "", dirty: false }),
    reducer: {
      SaveClicked: (_p, { state, props, tasks }) =>
        tasks.save.start({ id: props.noteId, text: state.text }),
      Cancelled: (_p, { tasks }) => tasks.save.cancel(),
      Typed: (_p, { state }) => state,
    },
    render: () => null,
  });
  expect(feature.run).type.not.toBeCallableWith([], {
    props: { noteId: "n" },
    hooks: {},
    layer: Layer.empty,
  });

  Editor.reducer({
    SaveClicked: (_p, { tasks }) =>
      // @ts-expect-error is not assignable
      tasks.save.start({ id: 1, text: "" }),
    Cancelled: (_p, { tasks }) => tasks.save.cancel(),
    Typed: (_p, { state }) => state,
  });
});

test("an unbound operation's `start` takes the effect, and no service leaks", () => {
  const { Editor } = slot;
  const quiet = Editor.reducer({
    SaveClicked: (_p, { tasks }) => tasks.loose.start(Effect.succeed("x")),
    Cancelled: (_p, { tasks }) => tasks.loose.cancel(),
    Typed: ({ text }, { tasks, draft }) => {
      draft.text = text;
      return tasks.loose.start(Effect.succeed(text));
    },
  });
  expect<ServicesOf<typeof quiet>>().type.toBe<never>();

  const loud = Editor.reducer({
    SaveClicked: (_p, { tasks }) => tasks.loose.start(Effect.flatMap(Api, (api) => api.load)),
    Cancelled: (_p, { state }) => state,
    Typed: (_p, { state }) => state,
  });
  expect<ServicesOf<typeof loud>>().type.toBe<Api>();

  Editor.reducer({
    SaveClicked: (_p, { tasks }) =>
      // @ts-expect-error is not assignable
      tasks.loose.start(Effect.succeed(1)),
    Cancelled: (_p, { state }) => state,
    Typed: (_p, { state }) => state,
  });
});

test("lifecycle handlers get the handles too", () => {
  const { Editor } = slot;
  Editor.reducer({
    SaveClicked: (_p, { state }) => state,
    Cancelled: (_p, { state }) => state,
    Typed: (_p, { state }) => state,
    Mounted: (_p, { tasks }) => tasks.loose.start(Effect.succeed("ready")),
  });
});

test("a feature without `tasks` has an empty `snapshot.tasks` and its own state", () => {
  const { props, state, actions } = slot;
  const Plain = define({ props, state, actions });
  Plain.reducer({
    SaveClicked: (_p, snapshot) => {
      expect(snapshot.tasks).type.toBe<{}>();
      expect(snapshot.state).type.toBe<{ readonly text: string; readonly dirty: boolean }>();
      return snapshot.state;
    },
    Cancelled: (_p, { state }) => state,
    Typed: (_p, { state }) => state,
  });
});

test("the clash rules are compile errors", () => {
  const { saveNote, loose, actions, props, state } = slot;

  // A task key that is also a state field.
  expect(define).type.not.toBeCallableWith({ props, state, tasks: { text: saveNote }, actions });

  // A task tag that is also a declared output tag.
  const SaveResolved = Action.output("SaveResolved", {});
  expect(define).type.not.toBeCallableWith({
    props,
    state,
    tasks: { save: saveNote },
    actions,
    outputs: SaveResolved,
  });

  // One operation under two keys.
  expect(define).type.not.toBeCallableWith({
    props,
    state,
    tasks: { a: saveNote, b: saveNote },
    actions,
  });

  // One operation in both `tasks` and `actions`.
  expect(define).type.not.toBeCallableWith({
    props,
    state,
    tasks: { save: saveNote },
    actions: [actions, saveNote],
  });

  // An announced operation.
  const shout = Task.output("Shout", { success: Schema.String });
  expect(define).type.not.toBeCallableWith({ props, state, tasks: { shout }, actions });

  // The control.
  expect(define).type.toBeCallableWith({
    props,
    state,
    tasks: { a: saveNote, b: loose },
    actions,
  });
});
