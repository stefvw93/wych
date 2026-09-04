import { Context, Effect, Option, Schema } from "effect";
import { expect, test } from "tstyche";
import { Task, type TaskValue } from "../utils/task";
import { Next, type Command, type ServicesOf } from "../lib";

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
  const search = Task("Search", { success: Schema.String, onError: Task.message });

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
    onError: Task.message,
  });
});

test("take-first is not a mode — it is a guard the handler writes", () => {
  expect(Task).type.not.toBeCallableWith("Search", {
    success: Schema.String,
    onError: Task.message,
    mode: "first",
  });
});

// ---------------------------------------------------------------------------
// Bound vs unbound `run`
// ---------------------------------------------------------------------------

test("declaring `run` makes the operation's `run` take its input, and only its input", () => {
  const search = Task("Search", {
    success: Schema.String,
    onError: Task.message,
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
    onError: Task.message,
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
  const search = Task("Search", { success: Schema.String, onError: Task.message });
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
  const search = Task.output("Search", { success: Schema.String, onError: Task.message });

  expect(search.run(Effect.succeed("ok"))).type.toBe<Command<SearchAction, never>>();
  expect(search.cancel).type.toBe<Command<SearchAction, never>>();
});

test("`Task.start` takes a lazy command, handed the state with `Pending` written", () => {
  const search = Task("Search", { success: Schema.String, onError: Task.message });
  type State = { readonly q: string; readonly search: TaskValue<string, string> };
  const state = { q: "x", search: Task.idle } as State;

  const next = Task.start(state, "search", (written) => {
    expect(written).type.toBe<State>();
    return search.run(Effect.succeed(written.q));
  });

  expect(next[0]).type.toBe<State>();
  expect(Next.command(next)).type.toBeAssignableTo<Command<SearchAction> | undefined>();
});
