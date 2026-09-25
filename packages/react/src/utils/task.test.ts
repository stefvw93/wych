import { Context, Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Action, Children, Command, define } from "../lib";
import { Task, type TaskCases, type TaskValue } from "./task";

class Api extends Context.Service<Api, { readonly load: Effect.Effect<string, Error> }>()("Api") {}

const Props = Schema.Struct({ children: Schema.optionalKey(Children) });
const Clicked = Action("Clicked", {});
const Cancelled = Action("Cancelled", {});
const load = Effect.flatMap(Api, (api) => api.load);
const layerOf = (value: Effect.Effect<string, Error>) => Layer.succeed(Api)({ load: value });

// --- folded -----------------------------------------------------------------

/**
 * The manual path: the operation in the `actions` slot, a field under a name
 * the feature chose, a `Pending` write on the fold that issues the command,
 * and two handlers that say where the result lands. Take-first here is a
 * guard the handler writes; the `tasks` slot has `mode: "first"` for it.
 */
const folded = (options?: {
  readonly mode?: "every";
  readonly takeFirst?: boolean;
  /** Spread `search.into("search")` instead of writing the two handlers. */
  readonly into?: boolean;
}) => {
  const search = Task("Search", {
    success: Schema.String,
    onError: Task.errorMessage,
    mode: options?.mode,
  });

  const State = Schema.Struct({ colorValue: Schema.String, search: Task.schema(Schema.String) });
  const Vocab = [Clicked, Cancelled, ...search.actions];
  const F = define({ props: Props, state: State, actions: Vocab });

  return {
    search,
    feature: F.create({
      initialState: F.initialState(() => ({ colorValue: "#000", search: Task.idle })),
      reducer: F.reducer({
        Clicked: (_a, { state }) =>
          options?.takeFirst && Task.isPending(state.search)
            ? state
            : [{ ...state, search: Task.pending }, search.run(load)],
        Cancelled: (_a, { state }) => [{ ...state, search: Task.idle }, search.cancel],
        ...(options?.into
          ? search.into("search")
          : {
              SearchResolved: (a, { state }) => ({ ...state, search: Task.resolved(a.value) }),
              SearchRejected: (a, { state }) => ({ ...state, search: Task.rejected(a.error) }),
            }),
      }),
      render: F.render(() => null),
    }),
  };
};

const run = (
  feature: { run: (...args: any[]) => Effect.Effect<any> },
  value: Effect.Effect<string, Error>,
  actions: ReadonlyArray<{ readonly _tag: string }> = [Clicked.make({})],
) =>
  Effect.runPromise(
    feature.run(actions, {
      props: {},
      hooks: {},
      layer: layerOf(value),
    }),
  );

const clicks = (n: number) => Array.from({ length: n }, () => Clicked.make({}));

describe("Task", () => {
  it("declares the two tags from the name, the command, and the field schema", () => {
    const search = Task("WallhavenSearch", { success: Schema.String, onError: Task.errorMessage });

    expect(search.actions.map((a) => a.make({ value: "x", error: "x" })._tag)).toEqual([
      "WallhavenSearchResolved",
      "WallhavenSearchRejected",
    ]);

    expect(Object.keys(search).sort()).toEqual([
      "Rejected",
      "Resolved",
      "actions",
      "cancel",
      "into",
      "rejectedInto",
      "resolvedInto",
      "run",
      "schema",
    ]);
  });

  it("into(key) folds both actions into the field", async () => {
    const { feature } = folded({ into: true });

    const ok = await run(feature, Effect.succeed("ok"));
    expect(ok.state).toEqual({ colorValue: "#000", search: Task.resolved("ok") });

    const failed = await run(feature, Effect.fail(new Error("boom")));
    expect(failed.state).toEqual({ colorValue: "#000", search: Task.rejected("boom") });
  });

  it("into returns the two handlers keyed by the operation's tags, spreading the rest of the state", () => {
    const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });
    const handlers = search.into("search");
    const state = { colorValue: "#000", search: Task.idle as TaskValue<string, string> };

    expect(Object.keys(handlers)).toEqual(["SearchResolved", "SearchRejected"]);
    expect(handlers.SearchResolved({ value: "v" }, { state })).toEqual({
      colorValue: "#000",
      search: Task.resolved("v"),
    });
    expect(handlers.SearchRejected({ error: "e" }, { state })).toEqual({
      colorValue: "#000",
      search: Task.rejected("e"),
    });
  });

  it("an explicit handler written after the spread wins", async () => {
    const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });
    const State = Schema.Struct({ colorValue: Schema.String, search: Task.schema(Schema.String) });
    const F = define({
      props: Props,
      state: State,
      actions: [Clicked, ...search.actions],
    });
    const feature = F.create({
      initialState: F.initialState(() => ({ colorValue: "#000", search: Task.idle })),
      reducer: F.reducer({
        Clicked: (_a, { state }) => Task.start(state, "search", search.run(load)),
        ...search.into("search"),
        SearchResolved: (a, { state }) => ({
          ...state,
          colorValue: "#fff",
          search: Task.resolved(a.value.toUpperCase()),
        }),
      }),
      render: F.render(() => null),
    });

    const ok = await run(feature, Effect.succeed("ok"));
    expect(ok.state).toEqual({ colorValue: "#fff", search: Task.resolved("OK") });

    // The generated `Rejected` handler still stands.
    const failed = await run(feature, Effect.fail(new Error("boom")));
    expect(failed.state).toEqual({ colorValue: "#000", search: Task.rejected("boom") });
  });

  it("resolves into whatever field the handler writes", async () => {
    const out = await run(folded().feature, Effect.succeed("ok"));
    expect(out.state.search).toEqual({ _tag: "Resolved", value: "ok" });
    expect(out.emitted.map((a: { _tag: string }) => a._tag)).toEqual(["SearchResolved"]);
  });

  it("maps a typed failure through onError", async () => {
    const out = await run(folded().feature, Effect.fail(new Error("boom")));
    expect(out.state.search).toEqual({ _tag: "Rejected", error: "boom" });
  });

  it("maps a defect through onError too — nothing reaches the Error lifecycle", async () => {
    const out = await run(folded().feature, Effect.die(new Error("bug")));
    expect(out.state.search).toEqual({ _tag: "Rejected", error: "bug" });
  });

  it("Task.errorMessage reads the name when the message is empty — a tagged error's tag, not its cause", async () => {
    class ServiceError extends Schema.TaggedError<ServiceError>()("ServiceError", {
      cause: Schema.Defect(),
    }) {}
    const out = await run(
      folded().feature,
      Effect.fail(new ServiceError({ cause: new TypeError("Failed to fetch") })),
    );
    expect(out.state.search).toEqual({ _tag: "Rejected", error: "ServiceError" });
  });

  it("writes Pending synchronously, on the fold that issued the command", () => {
    const next = folded().feature.reduce(Clicked.make({}), {
      state: { colorValue: "#000", search: Task.idle },
      props: {},
      hooks: {},
    });
    expect((next as readonly [any, any])[0].search).toEqual({ _tag: "Pending" });
  });

  it("take-latest: a second run interrupts the first, and the interrupt is not a rejection", async () => {
    const out = await run(folded().feature, Effect.as(Effect.sleep(50), "second"), clicks(2));
    expect(out.emitted.map((a: { _tag: string }) => a._tag)).toEqual(["SearchResolved"]);
    expect(out.state.search).toEqual({ _tag: "Resolved", value: "second" });
  });

  it("every: both runs go to completion", async () => {
    const out = await run(
      folded({ mode: "every" }).feature,
      Effect.as(Effect.sleep(50), "both"),
      clicks(2),
    );
    expect(out.emitted).toHaveLength(2);
  });

  it("on the manual path, take-first is an `isPending` guard that drops the second run", async () => {
    const out = await run(
      folded({ takeFirst: true }).feature,
      Effect.as(Effect.sleep(50), "first"),
      clicks(2),
    );
    expect(out.emitted).toHaveLength(1);
  });

  it("cancel interrupts the work, and the handler clears the field", async () => {
    const out = await run(folded().feature, Effect.as(Effect.sleep(50), "never seen"), [
      Clicked.make({}),
      Cancelled.make({}),
    ]);

    expect(out.emitted).toHaveLength(0);
    expect(out.state.search).toEqual({ _tag: "Idle" });
  });

  it("cancel is a bare command, booked under the operation's own group", () => {
    const { search } = folded();
    expect(search.cancel._tag).toBe("Cancel");
    expect((search.cancel as unknown as { readonly target: string }).target).toBe("Task/Search");
  });

  it("constructs the four cases", () => {
    expect(Task.idle).toEqual({ _tag: "Idle" });
    expect(Task.pending).toEqual({ _tag: "Pending" });
    expect(Task.resolved("v")).toEqual({ _tag: "Resolved", value: "v" });
    expect(Task.rejected("e")).toEqual({ _tag: "Rejected", error: "e" });
  });

  it("without `failure`, an omitted `onError` is Task.errorMessage", async () => {
    const quiet = Task("Quiet", { success: Schema.String, run: () => load });
    const F = define({
      props: Props,
      state: Schema.Struct({ quiet: quiet.schema }),
      actions: [Clicked, ...quiet.actions],
    });
    const feature = F.create({
      initialState: () => ({ quiet: Task.idle }),
      reducer: {
        Clicked: (_a, { state }) => Task.start(state, "quiet", quiet.run()),
        ...quiet.into("quiet"),
      },
      render: () => null,
    });
    const out = await run(feature, Effect.fail(new Error("boom")));
    expect(out.state.quiet).toEqual({ _tag: "Rejected", error: "boom" });
  });

  it("op.schema is the field schema of the operation's own success and failure", () => {
    const search = Task("Search", { success: Schema.Number });
    expect(Object.keys(search.schema.cases).sort()).toEqual([
      "Idle",
      "Pending",
      "Rejected",
      "Resolved",
    ]);
    expect(search.schema.cases.Resolved.make({ value: 1 })).toEqual({ _tag: "Resolved", value: 1 });
    expect(search.schema.cases.Rejected.make({ error: "e" })).toEqual({
      _tag: "Rejected",
      error: "e",
    });

    const typed = Task("Typed", {
      success: Schema.Number,
      failure: Schema.Struct({ code: Schema.Number }),
      onError: () => ({ code: 500 }),
    });
    expect(typed.schema.cases.Rejected.make({ error: { code: 1 } })).toEqual({
      _tag: "Rejected",
      error: { code: 1 },
    });
  });

  it("schema carries the four cases, with Schema.String as the default failure", () => {
    const schema = Task.schema(Schema.String);
    expect(Object.keys(schema.cases).sort()).toEqual(["Idle", "Pending", "Rejected", "Resolved"]);
    expect(schema.cases.Rejected.make({ error: "e" })).toEqual({ _tag: "Rejected", error: "e" });
  });

  it("the partial reads see one case each, and the guards narrow", () => {
    const resolved: TaskValue<string, string> = { _tag: "Resolved", value: "v" };
    const rejected: TaskValue<string, string> = { _tag: "Rejected", error: "e" };
    const pending: TaskValue<string, string> = { _tag: "Pending" };

    expect(Task.value(resolved)).toEqual(Option.some("v"));
    expect(Task.value(rejected)).toEqual(Option.none());
    expect(Task.value(pending)).toEqual(Option.none());

    expect(Task.error(rejected)).toEqual(Option.some("e"));
    expect(Task.error(resolved)).toEqual(Option.none());

    expect(Task.getOrElse(resolved, () => "fallback")).toBe("v");
    expect(Task.getOrElse(rejected, () => "fallback")).toBe("fallback");
    expect(Task.getOrElse(pending, () => "fallback")).toBe("fallback");

    expect([resolved, rejected, pending, Task.idle].map(Task.isIdle)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect([resolved, rejected, pending].map(Task.isPending)).toEqual([false, false, true]);
    expect([resolved, rejected, pending].map(Task.isResolved)).toEqual([true, false, false]);
    expect([resolved, rejected, pending].map(Task.isRejected)).toEqual([false, true, false]);
  });

  it("match covers the four cases, each handed its whole member", () => {
    const arms: TaskCases<string, string, string> = {
      Idle: () => "idle",
      Pending: () => "pending",
      Resolved: (r) => `resolved:${r.value}`,
      Rejected: (r) => `rejected:${r.error}`,
    };

    const values: ReadonlyArray<TaskValue<string, string>> = [
      { _tag: "Idle" },
      { _tag: "Pending" },
      { _tag: "Resolved", value: "v" },
      { _tag: "Rejected", error: "e" },
    ];

    expect(values.map((value) => Task.match(value, arms))).toEqual([
      "idle",
      "pending",
      "resolved:v",
      "rejected:e",
    ]);

    expect(Task.isPending({ _tag: "Pending" })).toBe(true);
    expect(Task.isPending({ _tag: "Idle" })).toBe(false);
  });
});

// --- bound work --------------------------------------------------------------

describe("resolvedInto / rejectedInto", () => {
  const Saved = Action.output("Saved", { revision: Schema.String });
  const save = Task("Save", { success: Schema.String, run: () => load });

  const build = (then: {
    readonly resolved?: (value: string, snapshot: any) => any;
    readonly rejected?: (error: string, snapshot: any) => any;
  }) => {
    const F = define({
      props: Props,
      state: Schema.Struct({ dirty: Schema.Boolean, save: save.schema, seen: Schema.String }),
      actions: [Clicked, save],
      outputs: Saved,
    });
    // Built outside the literal and spread as `object`: the fixture varies
    // which entries exist, which the reducer's own types cannot express.
    const extra = {
      ...(then.resolved ? { SaveResolved: save.resolvedInto("save", then.resolved) } : {}),
      ...(then.rejected ? { SaveRejected: save.rejectedInto("save", then.rejected) } : {}),
    };
    return F.create({
      initialState: () => ({ dirty: true, save: Task.idle, seen: "" }),
      reducer: {
        Clicked: (_a, { draft }) => Task.start(draft, "save", save.run()),
        ...save.into("save"),
        ...(extra as object),
      },
      render: () => null,
    });
  };

  it("writes the field into the draft, then hands the follow-up that draft", async () => {
    const feature = build({
      resolved: (value, { draft }) => {
        draft.seen = draft.save._tag;
        draft.dirty = false;
        return [draft, Command.output(Saved, { revision: value })];
      },
    });
    const out = await run(feature, Effect.succeed("r1"));
    expect(out.state).toEqual({
      dirty: false,
      save: { _tag: "Resolved", value: "r1" },
      seen: "Resolved",
    });
    expect(out.outputs).toEqual([{ _tag: "Saved", revision: "r1" }]);
  });

  it("the side without a follow-up is the plain `into` handler", async () => {
    const feature = build({ resolved: (_v, { draft }) => draft });
    const out = await run(feature, Effect.fail(new Error("boom")));
    expect(out.state.save).toEqual({ _tag: "Rejected", error: "boom" });
    expect(out.state.dirty).toBe(true);
  });

  it("rejectedInto writes `Rejected` first", async () => {
    const feature = build({
      rejected: (error, { draft }) => {
        draft.seen = `${draft.save._tag}:${error}`;
        return draft;
      },
    });
    const out = await run(feature, Effect.fail(new Error("boom")));
    expect(out.state.save).toEqual({ _tag: "Rejected", error: "boom" });
    expect(out.state.seen).toBe("Rejected:boom");
  });

  it("a lazy command beside the draft sees the finished state", async () => {
    const seen: Array<unknown> = [];
    const feature = build({
      resolved: (_v, { draft }) => [
        draft,
        (next: any) => Command.effect(() => Effect.sync(() => void seen.push(next.save))),
      ],
    });
    await run(feature, Effect.succeed("r1"));
    expect(seen).toEqual([{ _tag: "Resolved", value: "r1" }]);
  });

  it("returning another state than the draft is the fold's TypeError", async () => {
    const feature = build({ resolved: (_v, { state }) => ({ ...state }) });
    await expect(run(feature, Effect.succeed("r1"))).rejects.toThrow(/wrote into snapshot.draft/);
  });
});

describe("Task with `run`", () => {
  const search = Task("Search", {
    success: Schema.String,
    onError: Task.errorMessage,
    run: (query: string) => Effect.map(load, (value) => `${value}:${query}`),
  });

  const State = Schema.Struct({ search: Task.schema(Schema.String) });
  const Vocab = [Clicked, ...search.actions];
  const F = define({ props: Props, state: State, actions: Vocab });

  const feature = F.create({
    initialState: F.initialState(() => ({ search: Task.idle })),
    reducer: F.reducer({
      Clicked: (_a, { state }) => [{ ...state, search: Task.pending }, search.run("query")],
      SearchResolved: (a, { state }) => ({ ...state, search: Task.resolved(a.value) }),
      SearchRejected: (a, { state }) => ({ ...state, search: Task.rejected(a.error) }),
    }),
    render: F.render(() => null),
  });

  it("passes the input to the declared effect", async () => {
    const out = await run(feature, Effect.succeed("ok"));
    expect(out.state.search).toEqual({ _tag: "Resolved", value: "ok:query" });
  });
});

// --- announced ---------------------------------------------------------------

describe("Task.start on a draft", () => {
  it("writes Pending into the draft and returns the draft, not a copy", () => {
    const search = Task("Search", { success: Schema.String, onError: Task.errorMessage });
    const State = Schema.Struct({
      items: Schema.Array(Schema.String),
      search: Task.schema(Schema.String),
    });
    const F = define({
      props: Props,
      state: State,
      actions: [Clicked, ...search.actions],
    });
    let handed: unknown;
    let returned: unknown;
    const feature = F.create({
      initialState: F.initialState(() => ({ items: [], search: Task.idle })),
      reducer: F.reducer({
        Clicked: (_a, { draft }) => {
          handed = draft;
          draft.items.push("x");
          const next = Task.start(draft, "search", search.run(load));
          returned = next[0];
          return next;
        },
        ...search.into("search"),
      }),
      render: F.render(() => null),
    });

    const next = feature.reduce(Clicked.make({}), {
      state: { items: [], search: Task.idle },
      props: {},
      hooks: {},
    });

    // The tuple's state was the draft itself, so the fold could finish it.
    expect(returned).toBe(handed);
    expect(next).toEqual([{ items: ["x"], search: Task.pending }, expect.anything()]);
  });

  it("spreads a plain state as before", () => {
    const state = { search: Task.idle, other: 1 };
    const [next] = Task.start(state, "search", Command.none);
    expect(next).toEqual({ search: Task.pending, other: 1 });
    expect(next).not.toBe(state);
    expect(state.search).toBe(Task.idle);
  });
});

describe("Task.output", () => {
  const search = Task.output("Search", { success: Schema.String, onError: Task.errorMessage });
  const State = Schema.Struct({ colorValue: Schema.String });
  const Vocab = [Clicked];
  const Outputs = [...search.actions];
  const F = define({ props: Props, state: State, actions: Vocab, outputs: Outputs });

  const feature = F.create({
    initialState: F.initialState(() => ({ colorValue: "#000" })),
    reducer: F.reducer({ Clicked: (_a, { state }) => [state, search.run(load)] }),
    render: F.render(() => null),
  });

  it("has no into: an announced operation has no reducer handlers", () => {
    expect("into" in search).toBe(false);
    expect(Object.keys(search).sort()).toEqual([
      "Rejected",
      "Resolved",
      "actions",
      "cancel",
      "run",
      "schema",
    ]);
  });

  it("announces the result instead of folding it", async () => {
    const out = await run(feature, Effect.succeed("ok"));
    expect(out.outputs).toEqual([{ _tag: "SearchResolved", value: "ok" }]);
    expect(out.state).toEqual({ colorValue: "#000" });
  });

  it("announces a rejection", async () => {
    const out = await run(feature, Effect.fail(new Error("nope")));
    expect(out.outputs).toEqual([{ _tag: "SearchRejected", error: "nope" }]);
  });
});

// --- the `tasks` slot --------------------------------------------------------

describe("the `tasks` slot", () => {
  const Saved = Action.output("Saved", { revision: Schema.String });
  const actions = Action({ SaveClicked: {}, Cancelled: {}, Typed: { text: Schema.String } });
  const props = Schema.Struct({ noteId: Schema.String });
  const state = Schema.Struct({ text: Schema.String, dirty: Schema.Boolean });
  const runProps = { props: { noteId: "n1" }, hooks: {} };
  const snapshotOf = (extra: object = {}) => ({
    ...runProps,
    state: { text: "t", dirty: true, save: Task.idle, ...extra },
  });

  const saveOf = (mode?: "first") =>
    Task("Save", {
      success: Schema.String,
      mode,
      run: (note: { readonly id: string; readonly text: string }) =>
        Effect.map(load, (value) => `${value}:${note.id}:${note.text}`),
    });

  /** The target shape: a key per task, no settle handler unless one is asked for. */
  const editor = (options?: {
    readonly mode?: "first";
    readonly resolved?: (value: string, snapshot: any) => any;
    readonly rejected?: (error: string, snapshot: any) => any;
  }) => {
    const saveNote = saveOf(options?.mode);
    const Editor = define({ props, state, tasks: { save: saveNote }, actions, outputs: Saved });
    // Spread as `object`: the fixture varies which settle entries exist.
    const settle = {
      ...(options?.resolved
        ? {
            SaveResolved: ({ value }: { value: string }, s: unknown) => options.resolved!(value, s),
          }
        : {}),
      ...(options?.rejected
        ? {
            SaveRejected: ({ error }: { error: string }, s: unknown) => options.rejected!(error, s),
          }
        : {}),
    };
    const feature = Editor.create({
      initialState: (p) => ({ text: p.noteId, dirty: false }),
      reducer: {
        SaveClicked: (_p, { state, props, tasks }) =>
          tasks.save.start({ id: props.noteId, text: state.text }),
        Cancelled: (_p, { tasks }) => tasks.save.cancel(),
        Typed: ({ text }, { draft }) => {
          draft.text = text;
          draft.dirty = true;
          return draft;
        },
        ...(settle as object),
      },
      render: () => null,
    });
    return { saveNote, feature };
  };

  const runEditor = (
    feature: ReturnType<typeof editor>["feature"],
    value: Effect.Effect<string, Error>,
    seeds: ReadonlyArray<Parameters<typeof feature.reduce>[0]>,
  ) => Effect.runPromise(feature.run(seeds, { ...runProps, layer: layerOf(value) }));

  it("fills each task field with `Task.idle` under the feature's initial state", async () => {
    const { feature } = editor();
    const out = await runEditor(feature, Effect.succeed("ok"), []);
    expect(out.state).toEqual({ text: "n1", dirty: false, save: Task.idle });
  });

  it("merges the feature's initial state on top, so it may set a task field", async () => {
    const saveNote = saveOf();
    const Editor = define({ props, state, tasks: { save: saveNote }, actions });
    const feature = Editor.create({
      initialState: () => ({ text: "", dirty: false, save: Task.resolved("r0") }),
      reducer: {
        SaveClicked: (_p, { state }) => state,
        Cancelled: (_p, { state }) => state,
        Typed: (_p, { state }) => state,
      },
      render: () => null,
    });
    const out = await Effect.runPromise(
      feature.run([], { ...runProps, layer: layerOf(Effect.succeed("")) }),
    );
    expect(out.state.save).toEqual(Task.resolved("r0"));
  });

  it("start writes `Pending` and issues the work; the settle lands with no handler", async () => {
    const { feature } = editor();
    const next = feature.reduce(actions.SaveClicked.make(), snapshotOf());
    expect(Array.isArray(next) && next[0].save).toEqual(Task.pending);

    const out = await runEditor(feature, Effect.succeed("ok"), [actions.SaveClicked.make()]);
    expect(out.state.save).toEqual(Task.resolved("ok:n1:n1"));
    expect(out.emitted).toEqual([{ _tag: "SaveResolved", value: "ok:n1:n1" }]);
  });

  it("a rejection lands in the field with no handler", async () => {
    const { feature } = editor();
    const out = await runEditor(feature, Effect.fail(new Error("boom")), [
      actions.SaveClicked.make(),
    ]);
    expect(out.state.save).toEqual(Task.rejected("boom"));
  });

  it("folds a seeded settle action built from `op.Resolved` / `op.Rejected`", () => {
    const { saveNote, feature } = editor();
    expect(feature.reduce(saveNote.Resolved.make({ value: "r1" }), snapshotOf())).toEqual({
      text: "t",
      dirty: true,
      save: Task.resolved("r1"),
    });
    expect(feature.reduce(saveNote.Rejected.make({ error: "no" }), snapshotOf())).toEqual({
      text: "t",
      dirty: true,
      save: Task.rejected("no"),
    });
  });

  it("writes the settled field before the handler runs, in both `state` and `draft`", () => {
    const seen: Array<unknown> = [];
    const { saveNote, feature } = editor({
      resolved: (value, { state, draft }) => {
        seen.push(state.save, draft.save._tag);
        draft.dirty = false;
        return [draft, Command.output(Saved, { revision: value })];
      },
    });
    const next = feature.reduce(saveNote.Resolved.make({ value: "r1" }), snapshotOf());
    expect(seen).toEqual([Task.resolved("r1"), "Resolved"]);
    expect(Array.isArray(next) && next[0]).toEqual({
      text: "t",
      dirty: false,
      save: Task.resolved("r1"),
    });
  });

  it("a handler returning `snapshot.state` returns the field write alone", () => {
    const { saveNote, feature } = editor({
      resolved: (_value, { state }) => state,
      rejected: (_error, { state }) => [state, Command.none],
    });
    expect(feature.reduce(saveNote.Resolved.make({ value: "r1" }), snapshotOf())).toEqual({
      text: "t",
      dirty: true,
      save: Task.resolved("r1"),
    });
    const rejected = feature.reduce(saveNote.Rejected.make({ error: "no" }), snapshotOf());
    expect(Array.isArray(rejected) && rejected[0].save).toEqual(Task.rejected("no"));
  });

  it("a handler that writes into the draft and returns another state is the fold's TypeError", () => {
    const { saveNote, feature } = editor({
      resolved: (_value, { state, draft }) => {
        draft.dirty = false;
        return state;
      },
    });
    expect(() => feature.reduce(saveNote.Resolved.make({ value: "r1" }), snapshotOf())).toThrow(
      /wrote into snapshot.draft/,
    );
  });

  it("cancel writes `Idle` and issues the operation's cancel", async () => {
    const { saveNote, feature } = editor();
    const next = feature.reduce(actions.Cancelled.make(), snapshotOf({ save: Task.pending }));
    expect(next).toEqual([{ text: "t", dirty: true, save: Task.idle }, saveNote.cancel]);

    const out = await runEditor(feature, Effect.as(Effect.sleep(50), "never seen"), [
      actions.SaveClicked.make(),
      actions.Cancelled.make(),
    ]);
    expect(out.emitted).toEqual([]);
    expect(out.state.save).toEqual(Task.idle);
  });

  it("a handler writes other fields before or after calling a handle", () => {
    const Editor = define({ props, state, tasks: { save: saveOf() }, actions });
    const feature = Editor.create({
      initialState: () => ({ text: "", dirty: false }),
      reducer: {
        SaveClicked: (_p, { draft, tasks }) => {
          draft.dirty = false;
          const next = tasks.save.start({ id: "a", text: draft.text });
          draft.text = "after";
          return next;
        },
        Cancelled: (_p, { tasks }) => {
          const [written, command] = tasks.save.cancel();
          written.dirty = false;
          return [written, command];
        },
        Typed: (_p, { state }) => state,
      },
      render: () => null,
    });
    const started = feature.reduce(actions.SaveClicked.make(), snapshotOf());
    expect(Array.isArray(started) && started[0]).toEqual({
      text: "after",
      dirty: false,
      save: Task.pending,
    });
    const cancelled = feature.reduce(actions.Cancelled.make(), snapshotOf({ save: Task.pending }));
    expect(Array.isArray(cancelled) && cancelled[0]).toEqual({
      text: "t",
      dirty: false,
      save: Task.idle,
    });
  });

  it("an unbound operation's start takes the effect", async () => {
    const loose = Task("Loose", { success: Schema.String });
    const F = define({ props, state, tasks: { loose }, actions });
    const feature = F.create({
      initialState: () => ({ text: "", dirty: false }),
      reducer: {
        SaveClicked: (_p, { tasks }) => tasks.loose.start(load),
        Cancelled: (_p, { tasks }) => tasks.loose.cancel(),
        Typed: (_p, { state }) => state,
      },
      render: () => null,
    });
    const out = await Effect.runPromise(
      feature.run([actions.SaveClicked.make()], {
        ...runProps,
        layer: layerOf(Effect.succeed("loose")),
      }),
    );
    expect(out.state.loose).toEqual(Task.resolved("loose"));
  });

  it('under `mode: "first"`, start while `Pending` writes nothing and issues `Command.none`', async () => {
    const { feature } = editor({ mode: "first" });
    const pending = snapshotOf({ save: Task.pending });
    const next = feature.reduce(actions.SaveClicked.make(), pending);
    expect(next).toEqual([pending.state, Command.none]);
    expect(Array.isArray(next) && next[0]).toBe(pending.state);

    const out = await runEditor(feature, Effect.as(Effect.sleep(20), "first"), [
      actions.SaveClicked.make(),
      actions.SaveClicked.make(),
    ]);
    expect(out.emitted).toHaveLength(1);
    expect(out.state.save).toEqual(Task.resolved("first:n1:n1"));
  });

  it('under `mode: "first"`, a start after the settle runs again', async () => {
    const { feature } = editor({ mode: "first" });
    const next = feature.reduce(
      actions.SaveClicked.make(),
      snapshotOf({ save: Task.resolved("r0") }),
    );
    expect(Array.isArray(next) && next[0].save).toEqual(Task.pending);
  });

  it('`op.run` under `mode: "first"` is the raw command: it issues regardless, interrupting nothing', async () => {
    const saveNote = saveOf("first");
    const F = define({ props, state, actions: [actions, saveNote] });
    const feature = F.create({
      initialState: () => ({ text: "", dirty: false }),
      reducer: {
        SaveClicked: (_p, { state }) => [state, saveNote.run({ id: "a", text: "" })],
        Cancelled: (_p, { state }) => state,
        Typed: (_p, { state }) => state,
        SaveResolved: (_p, { state }) => state,
        SaveRejected: (_p, { state }) => state,
      },
      render: () => null,
    });
    const out = await Effect.runPromise(
      feature.run([actions.SaveClicked.make(), actions.SaveClicked.make()], {
        ...runProps,
        layer: layerOf(Effect.as(Effect.sleep(20), "raw")),
      }),
    );
    expect(out.emitted).toHaveLength(2);
  });

  it("keeps the snapshot's own keys to `state`, `props` and `hooks`", () => {
    let keys: Array<string> = [];
    const F = define({ props, state, tasks: { save: saveOf() }, actions });
    const feature = F.create({
      initialState: () => ({ text: "", dirty: false }),
      reducer: {
        SaveClicked: (_p, snapshot) => {
          keys = Object.keys(snapshot);
          return snapshot.tasks.save.start({ id: "a", text: "" });
        },
        Cancelled: (_p, { state }) => state,
        Typed: (_p, { state }) => state,
      },
      render: () => null,
    });
    feature.reduce(actions.SaveClicked.make(), snapshotOf());
    expect(keys.sort()).toEqual(["hooks", "props", "state"]);
  });

  it("a feature with no `tasks` hands an empty `snapshot.tasks`", () => {
    let tasks: unknown;
    const F = define({ props, state, actions });
    const feature = F.create({
      initialState: () => ({ text: "", dirty: false }),
      reducer: {
        SaveClicked: (_p, snapshot) => {
          tasks = snapshot.tasks;
          return snapshot.state;
        },
        Cancelled: (_p, { state }) => state,
        Typed: (_p, { state }) => state,
      },
      render: () => null,
    });
    feature.reduce(actions.SaveClicked.make(), { ...runProps, state: { text: "", dirty: false } });
    expect(tasks).toEqual({});
  });

  describe("clash rules, at `define`", () => {
    // Each call gets past the types through a loosened `define`: these are
    // the runtime checks, for a slot the types did not see.
    const defineLoose = define as unknown as (spec: object) => unknown;

    it("refuses a task key that is also a state field", () => {
      expect(() => defineLoose({ props, state, tasks: { text: saveOf() }, actions })).toThrow(
        new TypeError("define: tasks.text is also a field of the state schema"),
      );
    });

    it("refuses a task tag that is also declared in `actions` or `outputs`", () => {
      const SaveResolved = Action.output("SaveResolved", {});
      expect(() =>
        defineLoose({ props, state, tasks: { save: saveOf() }, actions, outputs: SaveResolved }),
      ).toThrow(
        new TypeError(
          'define: tag "SaveResolved" of tasks.save is also declared in "actions" or "outputs"',
        ),
      );
    });

    it("refuses one operation under two keys", () => {
      const saveNote = saveOf();
      expect(() =>
        defineLoose({ props, state, tasks: { a: saveNote, b: saveNote }, actions }),
      ).toThrow(new TypeError('define: one Task operation is under two keys, "a" and "b"'));
    });

    it("refuses two operations sharing a name under two keys", () => {
      expect(() =>
        defineLoose({ props, state, tasks: { a: saveOf(), b: saveOf() }, actions }),
      ).toThrow(new TypeError('define: tag "SaveResolved" is declared twice'));
    });

    it("refuses an operation in both `tasks` and `actions`", () => {
      const saveNote = saveOf();
      expect(() =>
        defineLoose({ props, state, tasks: { save: saveNote }, actions: [actions, saveNote] }),
      ).toThrow(/tag "SaveResolved" of tasks.save is also declared in "actions" or "outputs"/);
    });

    it("refuses a `Task.output` operation", () => {
      const shout = Task.output("Shout", { success: Schema.String });
      expect(() => defineLoose({ props, state, tasks: { shout }, actions })).toThrow(
        /tasks.shout is a Task.output operation/,
      );
    });

    it("refuses a value that is not a Task operation", () => {
      expect(() => defineLoose({ props, state, tasks: { save: Saved }, actions })).toThrow(
        new TypeError("define: tasks.save is not a Task operation"),
      );
    });
  });
});
