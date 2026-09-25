---
title: Tasks
description: Task, TaskOperation (run, cancel, schema, into, resolvedInto, rejectedInto), TaskValue, and the constructors, matcher and guards around them.
order: 7
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
import type { TagsOf, TaskMode, TaskOnError, TaskOperation, TaskValue } from "@wych/react";

class MailApi extends Context.Service<
  MailApi,
  { readonly list: (folder: string) => Effect.Effect<ReadonlyArray<string>, Error> }
>()("MailApi") {}

const MailApiLayer = Layer.succeed(MailApi)({ list: () => Effect.succeed(["Hello"]) });

const Subjects = Schema.Array(Schema.String);

const loadMail = Task("LoadMail", {
  success: Subjects,
  run: (folder: string) =>
    Effect.gen(function* () {
      const api = yield* MailApi;
      return yield* api.list(folder);
    }),
});

const actions = Action({ Opened: { folder: Schema.String }, Cancelled: {} });

const Mailbox = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ folder: Schema.String, subjects: loadMail.schema, count: Schema.Number }),
  action: [actions, loadMail],
});

export const mailbox = Mailbox.create({
  initialState: Mailbox.initialState(() => ({ folder: "", subjects: Task.idle, count: 0 })),
  reducer: Mailbox.reducer({
    Opened: ({ folder }, { draft }) => {
      draft.folder = folder;
      return Task.start(draft, "subjects", loadMail.run(folder));
    },
    Cancelled: (_payload, { draft }) => {
      draft.subjects = Task.idle;
      return [draft, loadMail.cancel];
    },
    ...loadMail.into("subjects"),
    LoadMailResolved: loadMail.resolvedInto("subjects", (value, { draft }) => {
      draft.count = value.length;
      return draft;
    }),
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
    readonly failure?: undefined;
    readonly onError?: TaskOnError<string>;
    readonly mode?: TaskMode;
    readonly run?: (input: Input) => Effect.Effect<Success["Type"], unknown, R>;
  },
): TaskOperation<Name, Success, Schema.String, Input, R>

Task<Name, Success, Failure extends Schema.Top, Input, R>(
  name: Name,
  config: {
    readonly success: Success;
    readonly failure: Failure;
    readonly onError: TaskOnError<Failure["Type"]>;
    readonly mode?: TaskMode;
    readonly run?: (input: Input) => Effect.Effect<Success["Type"], unknown, R>;
  },
): TaskOperation<Name, Success, Failure, Input, R>
```

Without `failure`, the field's error is a string and `onError` defaults to
`Task.errorMessage`; `loadMail` above declares neither. With a `failure`
schema, `onError` is required and produces its type.

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

A `failure` schema without `onError` is a compile error, `Schema.String`
included: the default mapping pairs with the default schema only.

```ts continue
// @ts-expect-error onError is required with a failure schema
const missingOnError = Task("MissingOnError", { success: Subjects, failure: Schema.String });
```

`name` must be capitalized, because it prefixes two action tags.

```ts continue
// @ts-expect-error "loadMail" is not Capitalize<string>
const lowercase = Task("loadMail", { success: Subjects });
```

## `TaskOperation`

```ts fragment
interface TaskOperation<Name, Success, Failure, Input, R, Ch> {
  readonly actions: readonly [ResolvedMessage, RejectedMessage];
  readonly run: (input: Input) => Command<TaskAction<...>, R>;
  readonly cancel: Command<TaskAction<...>>;
  readonly schema: TaskSchema<Success, Failure>;

  // internal operations only
  readonly into: <Key extends string>(key: Key) => TaskHandlers<Name, Key, Success, Failure>;
  readonly resolvedInto: <Key, Snap, N>(
    key: Key,
    then: (value: Success["Type"], snapshot: Snap) => N,
  ) => (payload: { readonly value: Success["Type"] }, snapshot: Snap) => N;
  readonly rejectedInto: <Key, Snap, N>(
    key: Key,
    then: (error: Failure["Type"], snapshot: Snap) => N,
  ) => (payload: { readonly error: Failure["Type"] }, snapshot: Snap) => N;
}
```

The operation holds no state; the feature's reducer writes the result into a
state field. `into`, `resolvedInto` and `rejectedInto` are absent on
`Task.output`: an announced operation has no reducer handler to write.

```ts continue
const operation: TaskOperation<"LoadMail", typeof Subjects, Schema.String, string, MailApi> =
  loadMail;

console.log(Object.keys(operation).sort());
// => ["actions", "cancel", "into", "rejectedInto", "resolvedInto", "run", "schema"]
```

### `actions`

Two messages, tagged `${Name}Resolved` with `{ value }` and `${Name}Rejected`
with `{ error }`. The operation itself goes into `define`'s `action` slot
(`action: [actions, loadMail]` above) and contributes both tags; `actions`
is the same pair, for reading.

```ts continue
console.log(loadMail.actions.map((message) => message.make({ value: [], error: "" })._tag));
// => ["LoadMailResolved", "LoadMailRejected"]

type MailboxTag = TagsOf<[typeof actions, typeof loadMail]>;
const settled: MailboxTag = "LoadMailResolved";
```

### `schema`

```ts fragment
schema: TaskSchema<Success, Failure>;
```

The schema of a state field holding this operation's `TaskValue`, built from
the operation's own `success` and `failure`, so the field cannot drift from
the work that fills it. `Mailbox` declares `subjects: loadMail.schema`.

```ts continue
console.log(Schema.is(loadMail.schema)(Task.resolved(["Hello"])));
// => true

const Uploads = Schema.Struct({ upload: typedLoad.schema });

// @ts-expect-error the field's error is NotFound
const stringError: typeof Uploads.Type = { upload: Task.rejected("offline") };
```

### `into`

```ts fragment
into: <Key extends string>(key: Key) => TaskHandlers<Name, Key, Success, Failure>;
```

`into(key)` returns the two settle handlers, keyed by the operation's own
tags, spread into the reducer:

```ts continue
const viaInto = Mailbox.reducer({
  Opened: ({ folder }, { draft }) => {
    draft.folder = folder;
    return Task.start(draft, "subjects", loadMail.run(folder));
  },
  Cancelled: (_payload, { draft }) => {
    draft.subjects = Task.idle;
    return [draft, loadMail.cancel];
  },
  ...loadMail.into("subjects"),
});
```

`Resolved` writes `Task.resolved(value)` into `key`, `Rejected` writes
`Task.rejected(error)`, and the rest of the state is spread through unchanged.
The spread site checks `key` against the feature's `State`: `key` must name a
`TaskValue<Success, Failure>` field of that state, with the operation's own
success and failure types. An optional field is accepted, the same as
`Task.start`.

```ts continue
const byHand = Mailbox.reducer({
  Opened: ({ folder }, { draft }) => {
    draft.folder = folder;
    return Task.start(draft, "subjects", loadMail.run(folder));
  },
  Cancelled: (_payload, { draft }) => {
    draft.subjects = Task.idle;
    return [draft, loadMail.cancel];
  },
  LoadMailResolved: ({ value }, { draft }) => {
    draft.subjects = Task.resolved(value);
    return draft;
  },
  LoadMailRejected: ({ error }, { draft }) => {
    draft.subjects = Task.rejected(error);
    return draft;
  },
});
```

`byHand` and `viaInto` fold the same. A handler written after the spread
replaces the generated one for that tag, the same way a later key wins in any
object literal; the other generated handler still stands.

### `resolvedInto` and `rejectedInto`

```ts fragment
resolvedInto: <Key extends string, Snap extends { readonly state: TaskField<Key, ...> }, N>(
  key: Key,
  then: (value: Success["Type"], snapshot: Snap) => N,
) => (payload: { readonly value: Success["Type"] }, snapshot: Snap) => N;

rejectedInto: <Key extends string, Snap extends { readonly state: TaskField<Key, ...> }, N>(
  key: Key,
  then: (error: Failure["Type"], snapshot: Snap) => N,
) => (payload: { readonly error: Failure["Type"] }, snapshot: Snap) => N;
```

The settle handler for a result that means more than the field write.
`resolvedInto(key, then)` is a `${Name}Resolved` handler: it writes
`Task.resolved(value)` into `snapshot.draft[key]`, then calls `then` with the
value and the same snapshot. `then` returns the draft, alone or beside a
command. `rejectedInto` is the same for `${Name}Rejected` with
`Task.rejected(error)`.

The entry is written in its key's position, after `...into(key)` for the
other side, which is what gives `snapshot` and a command's `dispatch` the
feature's own types. `mailbox` counts the subjects this way.

```ts continue
const counted = await Effect.runPromise(
  mailbox.run([actions.Opened.make({ folder: "inbox" })], {
    props: {},
    hooks: {},
    layer: MailApiLayer,
  }),
);

console.log(counted.state);
// => { folder: "inbox", subjects: { _tag: "Resolved", value: ["Hello"] }, count: 1 }
```

The follow-up may return a command beside the draft.

```ts continue
const reported: Array<string> = [];

const reporting = Mailbox.create({
  initialState: Mailbox.initialState(() => ({ folder: "", subjects: Task.idle, count: 0 })),
  reducer: Mailbox.reducer({
    Opened: ({ folder }, { draft }) => {
      draft.folder = folder;
      return Task.start(draft, "subjects", loadMail.run(folder));
    },
    Cancelled: (_payload, { draft }) => {
      draft.subjects = Task.idle;
      return [draft, loadMail.cancel];
    },
    ...loadMail.into("subjects"),
    LoadMailRejected: loadMail.rejectedInto("subjects", (error, { draft }) => {
      draft.count = 0;
      return [draft, Command.effect(() => Effect.sync(() => reported.push(error)))];
    }),
  }),
  render: Mailbox.render(() => null),
});

const offline = await Effect.runPromise(
  reporting.run([actions.Opened.make({ folder: "inbox" })], {
    props: {},
    hooks: {},
    layer: Layer.succeed(MailApi)({ list: () => Effect.fail(new Error("offline")) }),
  }),
);

console.log(offline.state.subjects);
// => { _tag: "Rejected", error: "offline" }
console.log(reported);
// => ["offline"]
```

The field is already written into the draft when `then` runs, so returning
another state is the fold's `TypeError`, on the
[finishing rules](/docs/reference/features#finishing-rules).

```ts continue
const spreadAfterWrite = Mailbox.create({
  initialState: Mailbox.initialState(() => ({ folder: "", subjects: Task.idle, count: 0 })),
  reducer: Mailbox.reducer({
    Opened: ({ folder }, { draft }) => {
      draft.folder = folder;
      return Task.start(draft, "subjects", loadMail.run(folder));
    },
    Cancelled: (_payload, { draft }) => {
      draft.subjects = Task.idle;
      return [draft, loadMail.cancel];
    },
    ...loadMail.into("subjects"),
    LoadMailResolved: loadMail.resolvedInto("subjects", (value, { state }) => ({
      ...state,
      count: value.length,
    })),
  }),
  render: Mailbox.render(() => null),
});

spreadAfterWrite.reduce(
  { _tag: "LoadMailResolved", value: ["Hello"] },
  { state: { folder: "inbox", subjects: Task.pending, count: 0 }, props: {}, hooks: {} },
);
// throws TypeError: handler wrote into snapshot.draft and returned a different state
```

### `run`

With `run` declared in the config, `op.run(input)` takes that input. Without
it, `op.run(effect)` takes the effect.

```ts continue
const unbound = Task("Upload", { success: Schema.String });

const unboundCommand = unbound.run(Effect.succeed("receipt_1"));
const boundCommand = loadMail.run("inbox");
```

A `run` that takes no input is still bound: the operation's `run` is called
with nothing.

```ts continue
const refresh = Task("Refresh", {
  success: Subjects,
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
const announceUpload = Task.output("Announce", { success: Schema.String });

const Announcer = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ note: Schema.String }),
  action: actions.Opened,
  output: announceUpload,
});

console.log(Object.keys(announceUpload).sort());
// => ["actions", "cancel", "run", "schema"]
```

The same operation with both actions on the outbound channel, so it goes into
the `output` slot. They leave through `onAnnounceResolved` and
`onAnnounceRejected` and never reach the reducer, so the operation has no
`into`, `resolvedInto` or `rejectedInto`.

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
  Opened: ({ folder }, { state, draft }) => {
    if (Task.isPending(state.subjects)) return state;
    draft.folder = folder;
    return Task.start(draft, "subjects", loadMail.run(folder));
  },
  Cancelled: (_payload, { draft }) => {
    draft.subjects = Task.idle;
    return [draft, loadMail.cancel];
  },
  ...loadMail.into("subjects"),
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

## `TaskOnError` and `Task.errorMessage`

```ts fragment
type TaskOnError<Failure> = (cause: Cause.Cause<unknown>) => Failure;
Task.errorMessage: TaskOnError<string>;
```

`onError` receives the whole `Cause`, so both a typed failure and a defect map
to `Failure`. `loadMail` declares no `onError`, so `Task.errorMessage` maps
both.

```ts continue
const failed = await Effect.runPromise(
  mailbox.run([actions.Opened.make({ folder: "inbox" })], {
    props: {},
    hooks: {},
    layer: Layer.succeed(MailApi)({ list: () => Effect.fail(new Error("offline")) }),
  }),
);

console.log(failed.state.subjects);
// => { _tag: "Rejected", error: "offline" }

const died = await Effect.runPromise(
  mailbox.run([actions.Opened.make({ folder: "inbox" })], {
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

`Task.errorMessage` is the error's message, or its name when the message is empty.
A `Schema.TaggedError` declared without a `message` field is an `Error` whose
message is `""`, and its name is the tag, so the field names the error instead
of showing nothing. The mapping does not read `cause`. When the wrapped error
carries the text the UI wants, say so in `onError`.

```ts continue
class MailApiError extends Schema.TaggedError<MailApiError>()("MailApiError", {
  cause: Schema.Defect(),
}) {}

const tagged = await Effect.runPromise(
  mailbox.run([actions.Opened.make({ folder: "inbox" })], {
    props: {},
    hooks: {},
    layer: Layer.succeed(MailApi)({
      list: () => Effect.fail(new MailApiError({ cause: new TypeError("Failed to fetch") })),
    }),
  }),
);

console.log(tagged.state.subjects);
// => { _tag: "Rejected", error: "MailApiError" }

const unwrapped = Task("LoadMailUnwrapped", {
  success: Subjects,
  onError: (cause) => {
    const error = Cause.squash(cause);
    return error instanceof MailApiError
      ? Task.errorMessage(Cause.fail(error.cause))
      : Task.errorMessage(cause);
  },
});
```

Interruption is the one cause `onError` never sees. Cancelled work dispatches
nothing.

```ts continue
const SlowApiLayer = Layer.succeed(MailApi)({
  list: () => Effect.as(Effect.sleep("50 millis"), ["Hello"] as ReadonlyArray<string>),
});

const cancelledRun = await Effect.runPromise(
  mailbox.run([actions.Opened.make({ folder: "inbox" }), actions.Cancelled.make()], {
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

The schema of a `TaskValue` field that no operation owns. The failure defaults
to `Schema.String`, to pair with `Task.errorMessage`. A field an operation
fills is declared with that operation's [`schema`](#schema).

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

Inside a handler, `Task.start` is usually called on `draft`: it writes
`Pending` into the draft in place and returns the draft in the tuple, so the
fold finishes it like any other write. `mailbox`'s own `Opened` handler does
this.

```ts continue
const openedFromDraft = mailbox.reduce(actions.Opened.make({ folder: "inbox" }), {
  state: { folder: "", subjects: Task.idle, count: 0 },
  props: {},
  hooks: {},
});

console.log(Next.state(openedFromDraft));
// => { folder: "inbox", subjects: { _tag: "Pending" }, count: 0 }
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
