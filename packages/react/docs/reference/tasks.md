---
title: Tasks
description: Task, TaskOperation, TaskValue, and the constructors, matcher and guards around them.
order: 6
---

# Tasks

A task is async work as two actions and a command. `Task(name, config)` declares
`${Name}Resolved` and `${Name}Rejected` plus the command that produces them.
The result lands in a `TaskValue` field, which has four cases.

Every snippet on this page builds on one feature: a mailbox that loads the
subjects of a folder through a `MailApi`, holds them in `state.subjects`, and
can be cancelled.

```tsx
import { Cause, Context, Effect, Layer, Option, Schema } from "effect";
import { Action, Command, define, Next, Task } from "@wych/react";
import type { TaskMode, TaskOnError, TaskOperation, TaskValue } from "@wych/react";

class MailApi extends Context.Service<
  MailApi,
  { readonly list: (folder: string) => Effect.Effect<ReadonlyArray<string>, Error> }
>()("MailApi") {}

const MailApiLayer = Layer.succeed(MailApi)({ list: () => Effect.succeed(["Hello"]) });

const Subjects = Schema.Array(Schema.String);

const loadMail = Task("LoadMail", {
  success: Subjects,
  onError: Task.message,
  run: (folder: string) =>
    Effect.gen(function* () {
      const api = yield* MailApi;
      return yield* api.list(folder);
    }),
});

const Opened = Action("Opened", { folder: Schema.String });
const Cancelled = Action("Cancelled", {});

const Mailbox = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ folder: Schema.String, subjects: Task.schema(Subjects) }),
  action: Action.of([Opened, Cancelled, ...loadMail.actions]),
});

export const mailbox = Mailbox.create({
  initialState: Mailbox.initialState(() => ({ folder: "", subjects: Task.idle })),
  reducer: Mailbox.reducer({
    Opened: ({ folder }, { state }) =>
      Task.start({ ...state, folder }, "subjects", loadMail.run(folder)),
    Cancelled: (_payload, { state }) => [{ ...state, subjects: Task.idle }, loadMail.cancel],
    LoadMailResolved: ({ value }, { state }) => ({ ...state, subjects: Task.resolved(value) }),
    LoadMailRejected: ({ error }, { state }) => ({ ...state, subjects: Task.rejected(error) }),
  }),
  render: Mailbox.render(({ state }) =>
    Task.match(state.subjects, {
      Idle: () => null,
      Pending: () => <p>Loading</p>,
      Resolved: ({ value }) => (
        <ul>
          {value.map((subject) => (
            <li key={subject}>{subject}</li>
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

const typedLoad = Task("TypedLoad", {
  success: Subjects,
  failure: NotFound,
  onError: (cause): typeof NotFound.Type => ({
    status: Cause.hasDies(cause) ? 500 : 404,
    message: String(Cause.squash(cause)),
  }),
  run: (folder: string) =>
    Effect.gen(function* () {
      const api = yield* MailApi;
      return yield* api.list(folder);
    }),
});
```

`name` must be capitalized, because it prefixes two action tags.

```ts continue
// @ts-expect-error "loadMail" is not Capitalize<string>
const lowercase = Task("loadMail", { success: Subjects, onError: Task.message });
```

## `TaskOperation`

```ts fragment
interface TaskOperation<Name, Success, Failure, Input, R, Ch> {
  readonly actions: readonly [ResolvedMessage, RejectedMessage];
  readonly run: (input: Input) => Command<TaskAction<...>, R>;
  readonly cancel: Command<TaskAction<...>>;
}
```

Three members. The operation holds no state; the feature's reducer writes the
result into a state field.

### `actions`

Two messages, tagged `${Name}Resolved` with `{ value }` and `${Name}Rejected`
with `{ error }`. Spread them into the feature's vocabulary.

```ts continue
console.log(loadMail.actions.map((message) => message.make({ value: [], error: "" })._tag));
// => ["LoadMailResolved", "LoadMailRejected"]

const vocabulary = Action.of([Opened, Cancelled, ...loadMail.actions]);
console.log(Object.keys(vocabulary.cases).sort());
// => ["Cancelled", "LoadMailRejected", "LoadMailResolved", "Opened"]
```

The `Resolved` and `Rejected` handlers write the result, so a handler can also
derive other state from it.

### `run`

With `run` declared in the config, `op.run(input)` takes that input. Without
it, `op.run(effect)` takes the effect.

```ts continue
const unbound = Task("Upload", { success: Schema.String, onError: Task.message });

const unboundCommand = unbound.run(Effect.succeed("receipt_1"));
const boundCommand = loadMail.run("inbox");
```

A `run` that takes no input is still bound: the operation's `run` is called
with nothing.

```ts continue
const refresh = Task("Refresh", {
  success: Subjects,
  onError: Task.message,
  run: () =>
    Effect.gen(function* () {
      const api = yield* MailApi;
      return yield* api.list("inbox");
    }),
});

const refreshCommand = refresh.run();
```

The handler of the triggering action returns `run`'s command, so the effect's
`R` reaches the feature's service requirements.

### `cancel`

```ts continue
const stop = loadMail.cancel; // Command.cancel("Task/LoadMail")
```

`cancel` writes nothing to the field. A field left `Pending` after a cancel
stays `Pending`, so the handler that returns `cancel` also resets the field, as
the `Cancelled` handler above does.

## `Task.output`

```ts continue
const announceUpload = Task.output("Announce", { success: Schema.String, onError: Task.message });

const Announcer = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ note: Schema.String }),
  action: Action.of([Opened]),
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
const everyLoad = Task("EveryLoad", {
  success: Subjects,
  onError: Task.message,
  mode: "every" satisfies TaskMode,
  run: (folder: string) =>
    Effect.gen(function* () {
      const api = yield* MailApi;
      return yield* api.list(folder);
    }),
});
```

Take-first is a guard in the handler: the handler reads the field and returns
the state unchanged while the task is `Pending`.

```ts continue
const takeFirst = Mailbox.reducer({
  Opened: ({ folder }, { state }) =>
    Task.isPending(state.subjects)
      ? state
      : Task.start({ ...state, folder }, "subjects", loadMail.run(folder)),
  Cancelled: (_payload, { state }) => [{ ...state, subjects: Task.idle }, loadMail.cancel],
  LoadMailResolved: ({ value }, { state }) => ({ ...state, subjects: Task.resolved(value) }),
  LoadMailRejected: ({ error }, { state }) => ({ ...state, subjects: Task.rejected(error) }),
});
```

## The group

Both modes book fibers under `` `Task/${Name}` ``, so `cancel` addresses them
all. The `Task/` prefix keeps a feature action tagged `LoadMail` from sharing
an address with this operation.

```ts continue
const groups: ReadonlyArray<string> = ["Task/LoadMail", "Task/TypedLoad"];
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
  mailbox.run([Opened.make({ folder: "inbox" })], {
    props: {},
    hooks: {},
    layer: Layer.succeed(MailApi)({ list: () => Effect.fail(new Error("offline")) }),
  }),
);

console.log(failed.state.subjects);
// => { _tag: "Rejected", error: "offline" }

const died = await Effect.runPromise(
  mailbox.run([Opened.make({ folder: "inbox" })], {
    props: {},
    hooks: {},
    layer: Layer.succeed(MailApi)({ list: () => Effect.die(new Error("bug")) }),
  }),
);

console.log(died.state.subjects);
// => { _tag: "Rejected", error: "bug" }
```

A defect lands in the field as a rejection and does not reach the
[`Error` lifecycle handler](/docs/reference/lifecycle). Use `Cause.hasDies` in
`onError` to tell the two apart.

Interruption is the one cause `onError` never sees. Cancelled work dispatches
nothing.

```ts continue
const SlowApiLayer = Layer.succeed(MailApi)({
  list: () => Effect.as(Effect.sleep("50 millis"), ["Hello"] as ReadonlyArray<string>),
});

const cancelledRun = await Effect.runPromise(
  mailbox.run([Opened.make({ folder: "inbox" }), Cancelled.make({})], {
    props: {},
    hooks: {},
    layer: SlowApiLayer,
  }),
);

console.log(cancelledRun.state.subjects);
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

`Pending` holds no value. There is no case that keeps the last value readable
while a refetch is pending.

### `Task.schema`

```ts fragment
Task.schema(success: Schema.Top): TaskSchema<Success, Schema.String>
Task.schema(success: Schema.Top, failure: Schema.Top): TaskSchema<Success, Failure>
```

The schema of a state field holding a `TaskValue`. The failure defaults to
`Schema.String`, to pair with `Task.message`.

```ts continue
const State = Schema.Struct({
  subjects: Task.schema(Subjects),
  upload: Task.schema(Schema.String, NotFound),
});
```

The handlers are what connect a field to an operation.

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

`Task.start` returns one tuple: the state with `Pending` written into `key`,
and the command. `key` is constrained to the state's own `TaskValue` fields,
so a typo is a compile error.

```ts continue
const started = Task.start(
  { folder: "inbox", subjects: Task.idle },
  "subjects",
  loadMail.run("inbox"),
);

console.log(started[0]);
// => { folder: "inbox", subjects: { _tag: "Pending" } }

// @ts-expect-error "folder" is not a TaskValue field
const typo = Task.start({ folder: "inbox", subjects: Task.idle }, "folder", loadMail.run("inbox"));
```

The command may be lazy. The thunk receives the state with `Pending` already
written.

```ts continue
const lazyStart = Task.start({ folder: "inbox", subjects: Task.idle }, "subjects", (next) =>
  loadMail.run(next.folder),
);
```

### `Task.resolved` and `Task.rejected`

The two constructors the `Resolved` and `Rejected` handlers write.

```ts continue
console.log(Task.resolved(["Hello"]));
// => { _tag: "Resolved", value: ["Hello"] }
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

`Task.match` is exhaustive: a missing case does not compile. Each case receives
the whole member, and the result is the union of the case return types.

```tsx continue
const label = Task.match(Task.resolved(["Hello"]), {
  Idle: () => 0,
  Pending: () => "loading",
  Resolved: ({ value }) => value.length,
  Rejected: ({ error }) => error,
});

console.log(label);
// => 1
```

```ts continue
// @ts-expect-error the Rejected case is missing
const partial = Task.match(Task.idle as TaskValue<ReadonlyArray<string>, string>, {
  Idle: () => null,
  Pending: () => null,
  Resolved: () => null,
});
```

### `Task.value`, `Task.error` and `Task.getOrElse`

Reads of one case, for a reducer or a guard.

```ts continue
const resolved: TaskValue<ReadonlyArray<string>, string> = Task.resolved(["Hello"]);

console.log(Option.isSome(Task.value(resolved)));
// => true
console.log(Option.isNone(Task.error(resolved)));
// => true
console.log(Task.getOrElse(resolved, () => [] as ReadonlyArray<string>));
// => ["Hello"]
```

`Task.value` is `Option.some(value)` for `Resolved` and `Option.none()`
otherwise. `Task.error` is `Option.some(error)` for `Rejected` and
`Option.none()` otherwise. `Task.getOrElse` reads the value or calls the
fallback.

### Guards

Four guards, each narrowing to one case.

```ts continue
const current: TaskValue<ReadonlyArray<string>, string> = failed.state.subjects;

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
