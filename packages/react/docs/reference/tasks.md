---
title: Tasks
description: Task, TaskOperation, TaskValue, and the constructors, matcher and guards around them.
order: 6
---

# Tasks

A task is async work as two actions and a command. `Task(name, config)` declares
`${Name}Resolved` and `${Name}Rejected` plus the command that produces them.
The result lands in a `TaskValue` field, which has four cases.

Every snippet on this page builds on one feature: a photo search that queries a
`PhotoApi`, holds the result in `state.photos`, and can be cancelled.

```tsx
import { Cause, Context, Effect, Layer, Option, Schema } from "effect";
import { Action, Command, define, Next, Task } from "@wych/react";
import type { TaskMode, TaskOnError, TaskOperation, TaskValue } from "@wych/react";

class PhotoApi extends Context.Service<
  PhotoApi,
  { readonly search: (query: string) => Effect.Effect<ReadonlyArray<string>, Error> }
>()("PhotoApi") {}

const PhotoApiLayer = Layer.succeed(PhotoApi)({ search: () => Effect.succeed(["a.jpg"]) });

const Photos = Schema.Array(Schema.String);

const photoSearch = Task("PhotoSearch", {
  success: Photos,
  onError: Task.message,
  run: (query: string) => Effect.flatMap(PhotoApi, (api) => api.search(query)),
});

const Searched = Action("Searched", { query: Schema.String });
const Cancelled = Action("Cancelled", {});

const Gallery = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, photos: Task.schema(Photos) }),
  action: Action.of([Searched, Cancelled, ...photoSearch.actions]),
});

export const gallery = Gallery.create({
  initialState: Gallery.initialState(() => ({ query: "", photos: Task.idle })),
  reducer: Gallery.reducer({
    Searched: ({ query }, { state }) =>
      Task.start({ ...state, query }, "photos", photoSearch.run(query)),
    Cancelled: (_payload, { state }) => [{ ...state, photos: Task.idle }, photoSearch.cancel],
    PhotoSearchResolved: ({ value }, { state }) => ({ ...state, photos: Task.resolved(value) }),
    PhotoSearchRejected: ({ error }, { state }) => ({ ...state, photos: Task.rejected(error) }),
  }),
  render: Gallery.render(({ state }) =>
    Task.match(state.photos, {
      Idle: () => null,
      Pending: () => <p>Searching</p>,
      Resolved: ({ value }) => (
        <ul>
          {value.map((url) => (
            <li key={url}>{url}</li>
          ))}
        </ul>
      ),
      Rejected: ({ error }) => <p>{error}</p>,
    }),
  ),
});
```

## `Task`

```ts fragment
Task<Name extends Capitalize<string>, Success extends Schema.Top, Input, R>(
  name: Name,
  config: {
    readonly success: Success;
    readonly onError: TaskOnError<string>;
    readonly mode?: TaskMode;
    readonly run?: (input: Input) => Effect.Effect<Success["Type"], unknown, R>;
  },
): TaskOperation<Name, Success, Schema.String, Input, R>

Task<Name, Success, Failure extends Schema.Top, Input, R>(
  name: Name,
  config: { success; failure: Failure; onError: TaskOnError<Failure["Type"]>; mode?; run? },
): TaskOperation<Name, Success, Failure, Input, R>
```

The first overload defaults `failure` to `Schema.String` and pairs with
`Task.message`. The second takes a `failure` schema and an `onError` that
produces its type.

```ts continue
const NotFound = Schema.Struct({ status: Schema.Number, message: Schema.String });

const typedSearch = Task("TypedSearch", {
  success: Photos,
  failure: NotFound,
  onError: (cause): typeof NotFound.Type => ({
    status: Cause.hasDies(cause) ? 500 : 404,
    message: String(Cause.squash(cause)),
  }),
  run: (query: string) => Effect.flatMap(PhotoApi, (api) => api.search(query)),
});
```

`name` must be capitalized, because it prefixes two action tags.

```ts continue
// @ts-expect-error "photoSearch" is not Capitalize<string>
const lowercase = Task("photoSearch", { success: Photos, onError: Task.message });
```

## `TaskOperation`

```ts fragment
interface TaskOperation<Name, Success, Failure, Input, R, Ch> {
  readonly actions: readonly [ResolvedMessage, RejectedMessage];
  readonly run: (input: Input) => Command<TaskAction<...>, R>;
  readonly cancel: Command<TaskAction<...>>;
}
```

Three members, and nothing state-shaped. Where the result lands is the
feature's business.

### `actions`

Two messages, tagged `${Name}Resolved` with `{ value }` and `${Name}Rejected`
with `{ error }`. Spread them into the feature's vocabulary.

```ts continue
console.log(photoSearch.actions.map((message) => message.make({ value: [], error: "" })._tag));
// => ["PhotoSearchResolved", "PhotoSearchRejected"]

const vocabulary = Action.of([Searched, Cancelled, ...photoSearch.actions]);
console.log(Object.keys(vocabulary.cases).sort());
// => ["Cancelled", "PhotoSearchRejected", "PhotoSearchResolved", "Searched"]
```

The reducer writes the result itself, which is where a handler can derive
something else from it.

### `run`

With `run` declared in the config, `op.run(input)` takes that input. Without
it, `op.run(effect)` takes the effect.

```ts continue
const unbound = Task("Upload", { success: Schema.String, onError: Task.message });

const unboundCommand = unbound.run(Effect.succeed("receipt_1"));
const boundCommand = photoSearch.run("cats");
```

A `run` that takes no input is still bound: the operation's `run` is called
with nothing.

```ts continue
const refresh = Task("Refresh", {
  success: Photos,
  onError: Task.message,
  run: () => Effect.flatMap(PhotoApi, (api) => api.search("")),
});

const refreshCommand = refresh.run();
```

`run` is returned from the triggering action's handler, which is what keeps the
effect's `R` visible to the feature's service requirements.

### `cancel`

```ts continue
const stop = photoSearch.cancel; // Command.cancel("Task/PhotoSearch")
```

Cancelling writes nothing. A cancelled task left `Pending` is a permanently
disabled button, so clear the field in the same return, as the `Cancelled`
handler above does.

## `Task.output`

```ts continue
const announceUpload = Task.output("Announce", { success: Schema.String, onError: Task.message });

const Announcer = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ note: Schema.String }),
  action: Action.of([Searched]),
  output: Action.of([...announceUpload.actions]),
});
```

The same operation with both actions on the outbound channel. They leave
through `onAnnounceResolved` and `onAnnounceRejected` and never reach the
reducer.

## `TaskMode`

```ts fragment
type TaskMode = "latest" | "every";
```

`"latest"` is the default and uses `Command.restart`: a second `run` interrupts
the first. `"every"` uses `Command.keyed`: both runs go to completion and the
last to settle wins.

```ts continue
const everySearch = Task("EverySearch", {
  success: Photos,
  onError: Task.message,
  mode: "every" satisfies TaskMode,
  run: (query: string) => Effect.flatMap(PhotoApi, (api) => api.search(query)),
});
```

Take-first is a guard in the handler, because it is a question about state.

```ts continue
const takeFirst = Gallery.reducer({
  Searched: ({ query }, { state }) =>
    Task.isPending(state.photos)
      ? state
      : Task.start({ ...state, query }, "photos", photoSearch.run(query)),
  Cancelled: (_payload, { state }) => [{ ...state, photos: Task.idle }, photoSearch.cancel],
  PhotoSearchResolved: ({ value }, { state }) => ({ ...state, photos: Task.resolved(value) }),
  PhotoSearchRejected: ({ error }, { state }) => ({ ...state, photos: Task.rejected(error) }),
});
```

## The group

Both modes book fibers under `` `Task/${Name}` ``, so `cancel` addresses them
all. The namespace prefix keeps a feature action tagged `PhotoSearch` from
sharing an address with this operation.

```ts continue
const groups: ReadonlyArray<string> = ["Task/PhotoSearch", "Task/TypedSearch"];
```

Group rules are in [Commands](/docs/reference/commands).

## `TaskOnError` and `Task.message`

```ts fragment
type TaskOnError<Failure> = (cause: Cause.Cause<unknown>) => Failure;
Task.message: TaskOnError<string>;
```

`onError` is mandatory. It receives the whole `Cause`, so both a typed failure
and a defect map to `Failure`.

```ts continue
const failed = await Effect.runPromise(
  gallery.run([Searched.make({ query: "cats" })], {
    props: {},
    hooks: {},
    layer: Layer.succeed(PhotoApi)({ search: () => Effect.fail(new Error("offline")) }),
  }),
);

console.log(failed.state.photos);
// => { _tag: "Rejected", error: "offline" }

const died = await Effect.runPromise(
  gallery.run([Searched.make({ query: "cats" })], {
    props: {},
    hooks: {},
    layer: Layer.succeed(PhotoApi)({ search: () => Effect.die(new Error("bug")) }),
  }),
);

console.log(died.state.photos);
// => { _tag: "Rejected", error: "bug" }
```

A defect lands in the field as a rejection and does not reach the
[`Error` lifecycle handler](/docs/reference/lifecycle). Use `Cause.hasDies` in
`onError` to tell the two apart.

Interruption is the one cause `onError` never sees. Cancelled work dispatches
nothing.

```ts continue
const SlowApiLayer = Layer.succeed(PhotoApi)({
  search: () => Effect.as(Effect.sleep("50 millis"), ["a.jpg"] as ReadonlyArray<string>),
});

const cancelledRun = await Effect.runPromise(
  gallery.run([Searched.make({ query: "cats" }), Cancelled.make({})], {
    props: {},
    hooks: {},
    layer: SlowApiLayer,
  }),
);

console.log(cancelledRun.state.photos);
// => { _tag: "Idle" }
```

## `TaskValue`

```ts fragment
type TaskValue<Success, Failure> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Resolved"; readonly value: Success }
  | { readonly _tag: "Rejected"; readonly error: Failure };
```

`Pending` drops any previous value. A refetch that keeps the last result
readable needs a fifth case, which nothing here provides.

### `Task.schema`

```ts fragment
Task.schema(success: Schema.Top): TaskSchema<Success, Schema.String>
Task.schema(success: Schema.Top, failure: Schema.Top): TaskSchema<Success, Failure>
```

The schema of a state field holding a `TaskValue`. The failure defaults to
`Schema.String`, to pair with `Task.message`.

```ts continue
const State = Schema.Struct({
  photos: Task.schema(Photos),
  upload: Task.schema(Schema.String, NotFound),
});
```

Nothing connects the field to an operation but the handlers you write.

### `Task.idle` and `Task.pending`

```ts continue
const initial: TaskValue<ReadonlyArray<string>, string> = Task.idle;
console.log(Task.idle);
// => { _tag: "Idle" }
console.log(Task.pending);
// => { _tag: "Pending" }
```

`Task.idle` is the initial value for a field. `Task.pending` is written on the
fold that issues the command, so a button is already disabled when the click
handler returns.

### `Task.start`

```ts fragment
Task.start<State, Key extends TaskKeys<State>, Action, R>(
  state: State,
  key: Key,
  command: Command<Action, R> | LazyCommand<State, Action, R>,
): readonly [State, Command<Action, R> | LazyCommand<State, Action, R>]
```

`Pending` and the command as one return. `key` is constrained to the state's
own `TaskValue` fields, so a typo is a compile error.

```ts continue
const started = Task.start({ query: "cats", photos: Task.idle }, "photos", photoSearch.run("cats"));

console.log(started[0]);
// => { query: "cats", photos: { _tag: "Pending" } }

// @ts-expect-error "query" is not a TaskValue field
const typo = Task.start({ query: "cats", photos: Task.idle }, "query", photoSearch.run("cats"));
```

The command may be lazy. The thunk receives the state with `Pending` already
written.

```ts continue
const lazyStart = Task.start({ query: "cats", photos: Task.idle }, "photos", (next) =>
  photoSearch.run(next.query),
);
```

### `Task.resolved` and `Task.rejected`

The two constructors the `Resolved` and `Rejected` handlers write.

```ts continue
console.log(Task.resolved(["a.jpg"]));
// => { _tag: "Resolved", value: ["a.jpg"] }
console.log(Task.rejected("offline"));
// => { _tag: "Rejected", error: "offline" }
```

## Reading a `TaskValue`

### `Task.match`

```ts fragment
Task.match<Success, Failure, Cases>(
  value: TaskValue<Success, Failure>,
  cases: { Idle; Pending; Resolved; Rejected },
): TaskMatched<Cases>
```

Total: a missing arm does not compile. Each arm receives the whole member, and
the result is the union of what the arms return.

```tsx continue
const label = Task.match(Task.resolved(["a.jpg"]), {
  Idle: () => 0,
  Pending: () => "searching",
  Resolved: ({ value }) => value.length,
  Rejected: ({ error }) => error,
});

console.log(label);
// => 1
```

```ts continue
// @ts-expect-error the Rejected arm is missing
const partial = Task.match(Task.idle as TaskValue<ReadonlyArray<string>, string>, {
  Idle: () => null,
  Pending: () => null,
  Resolved: () => null,
});
```

### `Task.value`, `Task.error` and `Task.getOrElse`

The partial reads, for a reducer or a guard.

```ts continue
const resolved: TaskValue<ReadonlyArray<string>, string> = Task.resolved(["a.jpg"]);

console.log(Option.isSome(Task.value(resolved)));
// => true
console.log(Option.isNone(Task.error(resolved)));
// => true
console.log(Task.getOrElse(resolved, () => [] as ReadonlyArray<string>));
// => ["a.jpg"]
```

`Task.value` is `Option.some(value)` for `Resolved` and `Option.none()`
otherwise. `Task.error` is `Option.some(error)` for `Rejected` and
`Option.none()` otherwise. `Task.getOrElse` reads the value or calls the
fallback.

### Guards

Four guards, each narrowing to one case.

```ts continue
const current: TaskValue<ReadonlyArray<string>, string> = failed.state.photos;

console.log(Task.isIdle(current));
// => false
console.log(Task.isPending(current));
// => false
console.log(Task.isResolved(current));
// => false
console.log(Task.isRejected(current));
// => true

const size = Task.isResolved(current) ? current.value.length : 0;
console.log(size);
// => 0
```
