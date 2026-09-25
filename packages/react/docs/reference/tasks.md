---
title: Tasks
description: Task, the tasks slot on define (snapshot.tasks, settle handlers, TaskMode, the clash rules), TaskOperation (run, cancel, schema, Resolved, Rejected, into, resolvedInto, rejectedInto), TaskValue, and the constructors, matcher and guards around them.
order: 7
---

# Tasks

A task is async work as two actions and a command. `Task(name, config)` declares
`${Name}Resolved` and `${Name}Rejected` plus the command that produces them.
The result lands in a `TaskValue` field, which has four cases. The `tasks`
slot on `define` binds an operation to that field under its key.

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
  state: Schema.Struct({ folder: Schema.String, count: Schema.Number }),
  tasks: { subjects: loadMail },
  actions,
});

export const mailbox = Mailbox.create({
  initialState: Mailbox.initialState(() => ({ folder: "", count: 0 })),
  reducer: Mailbox.reducer({
    Opened: ({ folder }, { draft, tasks }) => {
      draft.folder = folder;
      return tasks.subjects.start(folder);
    },
    Cancelled: (_payload, { tasks }) => tasks.subjects.cancel(),
    LoadMailResolved: ({ value }, { draft }) => {
      draft.count = value.length;
      return draft;
    },
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

## The `tasks` slot

```ts fragment
define({
  props: Schema.Struct,
  state: Schema.Struct,
  tasks?: { readonly [key: string]: TaskOperation }, // internal operations only
  actions: MemberSource<"internal">,
  outputs?: MemberSource<"outbound">,
})
// State: the state schema's fields plus one TaskValue<Success, Failure> per key
// Action: the declared actions plus `${Name}Resolved` and `${Name}Rejected` per task
```

`tasks` takes a record of internal operations. Each key adds a
`TaskValue<Success, Failure>` field to `State`, typed and validated by the
operation's [`schema`](#schema), and the operation's two actions to the action
union. `Mailbox` declares `subjects` this way, so `state.subjects` exists
without a line in the state schema.

The field starts `Idle`: `initialState` is typed without the task keys, and
the runtime fills each key with `Task.idle` under what `initialState` returns.
A hand-built state for `reduce` includes the key.

```ts continue
const fresh = await Effect.runPromise(
  mailbox.run([], { props: {}, hooks: {}, layer: MailApiLayer }),
);

console.log(fresh.state);
// => { folder: "", count: 0, subjects: { _tag: "Idle" } }

const idleMailbox = { state: { folder: "", count: 0, subjects: Task.idle }, props: {}, hooks: {} };
const pendingMailbox = {
  state: { folder: "inbox", count: 0, subjects: Task.pending },
  props: {},
  hooks: {},
};
```

`subscriptions` stays on `create`: it is a function of the snapshot. The task
binding is a static declaration, like the state schema, so it lives on
`define`.

### `snapshot.tasks`

```ts fragment
interface ReducerSnapshot<Props, State, H, Tasks> extends Snapshot<Props, State, H> {
  readonly draft: Draft<State>;
  readonly tasks: TaskHandles<Tasks, State>; // one handle per key of the slot
}

// the handle under snapshot.tasks[key]
start(input: Input): readonly [Draft<State>, Command<TaskAction<Name, Success, Failure>, R>]
// for an operation declared without `run`
start<V extends Success, E = never, R2 = never>(
  effect: Effect.Effect<V, E, R2>,
): readonly [Draft<State>, Command<TaskAction<Name, Success, Failure>, R2>]
cancel(): readonly [Draft<State>, Command<TaskAction<Name, Success, Failure>>]
```

A reducer handler receives one handle per key, lifecycle handlers included.
Both methods write the field into `snapshot.draft` and return the draft beside
the operation's command, so the call is the handler's return. A feature
without a slot hands `{}`. `render` and `subscriptions` have no handles:
neither changes state.

### `start(input)`

`start(input)` writes `Pending` into the draft and returns
`[draft, op.run(input)]`. The command carries the operation's `R`, so the
feature's service requirements read it off the handler's return. A handler may
write other draft fields before or after the call; `mailbox`'s `Opened`
handler writes `folder` first.

```ts continue
const opened = mailbox.reduce(actions.Opened.make({ folder: "inbox" }), idleMailbox);

console.log(Next.state(opened));
// => { folder: "inbox", count: 0, subjects: { _tag: "Pending" } }
console.log(Next.command(opened) !== undefined);
// => true
```

An operation declared without `run` has a `start` that takes the effect.

```ts continue
const Upload = Task("Upload", { success: Schema.String });

const Uploader = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ name: Schema.String }),
  tasks: { receipt: Upload },
  actions: actions.Opened,
});

const uploader = Uploader.create({
  initialState: () => ({ name: "" }),
  reducer: {
    Opened: ({ folder }, { tasks }) => tasks.receipt.start(Effect.succeed(`receipt:${folder}`)),
  },
  render: () => null,
});

const uploaded = await Effect.runPromise(
  uploader.run([actions.Opened.make({ folder: "inbox" })], {
    props: {},
    hooks: {},
    layer: Layer.empty,
  }),
);

console.log(uploaded.state);
// => { name: "", receipt: { _tag: "Resolved", value: "receipt:inbox" } }
```

### `cancel()`

`cancel()` writes `Idle` into the draft and returns `[draft, op.cancel]`,
which interrupts the work in flight.

```ts continue
const cancelled = mailbox.reduce(actions.Cancelled.make(), pendingMailbox);

console.log(Next.state(cancelled));
// => { folder: "inbox", count: 0, subjects: { _tag: "Idle" } }
console.log(Next.command(cancelled)?._tag);
// => "Cancel"
```

Through `run`, a start followed by a cancel emits nothing and leaves the field
`Idle`.

```ts continue
const SlowApiLayer = Layer.succeed(MailApi)({
  list: (folder) => Effect.as(Effect.sleep("50 millis"), [folder] as ReadonlyArray<string>),
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
console.log(cancelledRun.emitted);
// => []
```

### Settle handlers

The `${Name}Resolved` and `${Name}Rejected` keys are optional in the reducer
of a slot task. The fold writes `Task.resolved(value)` or
`Task.rejected(error)` into the field first; with no handler, that write is
the result. `mailbox` has no `LoadMailRejected` handler.

```ts continue
const rejectedByFold = mailbox.reduce(loadMail.Rejected.make({ error: "offline" }), pendingMailbox);

console.log(Next.state(rejectedByFold));
// => { folder: "inbox", count: 0, subjects: { _tag: "Rejected", error: "offline" } }
```

A settle handler receives the action's payload, `{ value }` or `{ error }`,
like every other handler, and runs over the state with the field already
written: both `snapshot.state` and `snapshot.draft` hold the settled case.
`mailbox`'s `LoadMailResolved` handler counts the subjects beside the write.

```ts continue
const resolvedByFold = mailbox.reduce(
  loadMail.Resolved.make({ value: ["Hello", "Re: Hello"] }),
  pendingMailbox,
);

console.log(Next.state(resolvedByFold));
// => { folder: "inbox", count: 2, subjects: { _tag: "Resolved", value: ["Hello", "Re: Hello"] } }
```

Returning `snapshot.state` from a settle handler returns the field write alone.

```ts continue
let seenByHandler = "";

const observing = Mailbox.create({
  initialState: Mailbox.initialState(() => ({ folder: "", count: 0 })),
  reducer: Mailbox.reducer({
    Opened: ({ folder }, { tasks }) => tasks.subjects.start(folder),
    Cancelled: (_payload, { tasks }) => tasks.subjects.cancel(),
    LoadMailResolved: (_payload, { state, draft }) => {
      seenByHandler = `${state.subjects._tag}/${draft.subjects._tag}`;
      return state;
    },
  }),
  render: Mailbox.render(() => null),
});

const observed = observing.reduce(loadMail.Resolved.make({ value: ["Hello"] }), pendingMailbox);

console.log(Next.state(observed));
// => { folder: "inbox", count: 0, subjects: { _tag: "Resolved", value: ["Hello"] } }
console.log(seenByHandler);
// => "Resolved/Resolved"
```

Writing into the draft and returning another state is the fold's `TypeError`,
on the [finishing rules](/docs/reference/features#finishing-rules).

```ts continue
const mixedSettle = Mailbox.create({
  initialState: Mailbox.initialState(() => ({ folder: "", count: 0 })),
  reducer: Mailbox.reducer({
    Opened: ({ folder }, { tasks }) => tasks.subjects.start(folder),
    Cancelled: (_payload, { tasks }) => tasks.subjects.cancel(),
    LoadMailResolved: ({ value }, { state, draft }) => {
      draft.count = value.length;
      return state;
    },
  }),
  render: Mailbox.render(() => null),
});

mixedSettle.reduce(loadMail.Resolved.make({ value: ["Hello"] }), pendingMailbox);
// throws TypeError: handler wrote into snapshot.draft and returned a different state
```

### `Resolved` and `Rejected`

```ts fragment
readonly Resolved: Message<`${Name}Resolved`, { readonly value: Success }>;
readonly Rejected: Message<`${Name}Rejected`, { readonly error: Failure }>;
```

The operation's two message schemas by name, the same pair as
[`actions`](#actions). `make` builds the message a test seeds or folds.

```ts continue
console.log(loadMail.Resolved.make({ value: ["Hello"] }));
// => { _tag: "LoadMailResolved", value: ["Hello"] }
console.log(loadMail.Rejected.make({ error: "offline" }));
// => { _tag: "LoadMailRejected", error: "offline" }
console.log(loadMail.Resolved === loadMail.actions[0]);
// => true
```

### `TaskMode`

```ts fragment
type TaskMode = "latest" | "every" | "first";
```

Concurrency is a property of the operation, declared once. `"latest"` is the
default and uses `Command.restart`: a second start interrupts the first.
`"every"` uses `Command.keyed`: both runs go to completion and the last to
settle wins. `"first"` keeps the running one: the slot's `start` writes
nothing and returns `[draft, Command.none]` while the field is `Pending`.

`SlowApiLayer` resolves each folder to itself after a delay, so the folder in
the field names the run that settled.

```ts continue
const twoFolders = [
  actions.Opened.make({ folder: "inbox" }),
  actions.Opened.make({ folder: "sent" }),
];

const latest = await Effect.runPromise(
  mailbox.run(twoFolders, { props: {}, hooks: {}, layer: SlowApiLayer }),
);

console.log(latest.state.subjects);
// => { _tag: "Resolved", value: ["sent"] }
console.log(latest.emitted.length);
// => 1
```

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

const everyMailbox = define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  tasks: { subjects: everyLoad },
  actions,
}).create({
  initialState: () => ({}),
  reducer: {
    Opened: ({ folder }, { tasks }) => tasks.subjects.start(folder),
    Cancelled: (_payload, { tasks }) => tasks.subjects.cancel(),
  },
  render: () => null,
});

const every = await Effect.runPromise(
  everyMailbox.run(twoFolders, { props: {}, hooks: {}, layer: SlowApiLayer }),
);

console.log(every.emitted.length);
// => 2
```

```ts continue
const firstLoad = Task("FirstLoad", {
  success: Subjects,
  mode: "first",
  run: (folder: string) =>
    Effect.gen(function* () {
      const api = yield* MailApi;
      return yield* api.list(folder);
    }),
});

const firstMailbox = define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  tasks: { subjects: firstLoad },
  actions,
}).create({
  initialState: () => ({}),
  reducer: {
    Opened: ({ folder }, { tasks }) => tasks.subjects.start(folder),
    Cancelled: (_payload, { tasks }) => tasks.subjects.cancel(),
  },
  render: () => null,
});

const alreadyPending = { state: { subjects: Task.pending }, props: {}, hooks: {} };
const dropped = firstMailbox.reduce(actions.Opened.make({ folder: "sent" }), alreadyPending);

console.log(Next.state(dropped) === alreadyPending.state);
// => true
console.log(Next.command(dropped)?._tag);
// => "None"

const first = await Effect.runPromise(
  firstMailbox.run(twoFolders, { props: {}, hooks: {}, layer: SlowApiLayer }),
);

console.log(first.state.subjects);
// => { _tag: "Resolved", value: ["inbox"] }
```

A start after the settle runs again, and a `cancel()` writes `Idle`, so the
next start runs. The mode reads the field through the draft, so a handler
that wrote `Pending` itself before calling `start` gets the no-op too.
[`op.run`](#run) is the raw command and issues under every mode.

### Clash rules

Each rule throws a `TypeError` at `define`, and is a compile error where the
types can express it.

A task key equal to a state field:

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({ folder: Schema.String }),
  // @ts-expect-error "folder" is a field of the state schema
  tasks: { folder: loadMail },
  actions,
});
// throws TypeError: define: tasks.folder is also a field of the state schema
```

A task tag equal to a declared action or output tag:

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  // @ts-expect-error tag "LoadMailResolved" is also declared in "outputs"
  tasks: { subjects: loadMail },
  actions,
  outputs: Action.output("LoadMailResolved"),
});
// throws TypeError: define: tag "LoadMailResolved" of tasks.subjects is also declared in "actions" or "outputs"
```

One operation under two keys:

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  // @ts-expect-error one operation under two keys
  tasks: { inbox: loadMail, sent: loadMail },
  actions,
});
// throws TypeError: define: one Task operation is under two keys, "inbox" and "sent"
```

One operation in both `tasks` and `actions`, which the tag rule catches:

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  // @ts-expect-error tag "LoadMailResolved" is also declared in "actions"
  tasks: { subjects: loadMail },
  actions: [actions, loadMail],
});
// throws TypeError: define: tag "LoadMailResolved" of tasks.subjects is also declared in "actions" or "outputs"
```

A `Task.output` operation, whose actions never reach the fold that would
write the field:

```ts continue
const shout = Task.output("Shout", { success: Schema.String });

define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  // @ts-expect-error a Task.output operation is outbound
  tasks: { shout },
  actions,
});
// throws TypeError: define: tasks.shout is a Task.output operation; its actions never reach the fold that would write the field
```

A value that is not an operation:

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  // @ts-expect-error a message is not a Task operation
  tasks: { subjects: actions.Opened },
  actions,
});
// throws TypeError: define: tasks.subjects is not a Task operation
```

## `TaskOperation`

```ts fragment
interface TaskOperation<Name, Success, Failure, Input, R, Ch> {
  readonly actions: readonly [ResolvedMessage, RejectedMessage];
  readonly Resolved: ResolvedMessage;
  readonly Rejected: RejectedMessage;
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

The operation holds no state. In the `tasks` slot the fold writes its field;
on the manual path the feature's reducer writes it. `into`, `resolvedInto` and
`rejectedInto` are absent on `Task.output`: an announced operation has no
reducer handler to write.

```ts continue
const operation: TaskOperation<"LoadMail", typeof Subjects, Schema.String, string, MailApi> =
  loadMail;

console.log(Object.keys(operation).sort());
// => ["Rejected", "Resolved", "actions", "cancel", "into", "rejectedInto", "resolvedInto", "run", "schema"]
```

### The manual path

For work whose result is not one field, the operation goes into the
`actions` slot and the reducer writes the field by hand: [`Task.start`](#taskstart)
to start it, [`into`](#into) or a hand-written entry to settle it. The
reducer is exhaustive over the action union, so both settle handlers are
required. `ManualMailbox` stores the same field this way.

```ts continue
const ManualMailbox = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ folder: Schema.String, subjects: loadMail.schema, count: Schema.Number }),
  actions: [actions, loadMail],
});

const manualMailbox = ManualMailbox.create({
  initialState: ManualMailbox.initialState(() => ({ folder: "", subjects: Task.idle, count: 0 })),
  reducer: ManualMailbox.reducer({
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
  render: ManualMailbox.render(() => null),
});

const manual = await Effect.runPromise(
  manualMailbox.run([actions.Opened.make({ folder: "inbox" })], {
    props: {},
    hooks: {},
    layer: MailApiLayer,
  }),
);

console.log(manual.state);
// => { folder: "inbox", subjects: { _tag: "Resolved", value: ["Hello"] }, count: 1 }
```

### `actions`

Two messages, tagged `${Name}Resolved` with `{ value }` and `${Name}Rejected`
with `{ error }`. The operation itself goes into `define`'s `tasks` slot under
its field key, or into the `actions` slot (`actions: [actions, loadMail]` in
`ManualMailbox`), and contributes both tags either way; `actions` is the same
pair, for reading.

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
the work that fills it. The `tasks` slot adds each field with it;
`ManualMailbox` declares `subjects: loadMail.schema` by hand.

```ts continue
console.log(Schema.is(loadMail.schema)(Task.resolved(["Hello"])));
// => true

const Uploads = Schema.Struct({ upload: typedLoad.schema });

// @ts-expect-error the field's error is NotFound
const stringError: typeof Uploads.Type = { upload: Task.rejected("offline") };
```

### `run`

With `run` declared in the config, `op.run(input)` takes that input. Without
it, `op.run(effect)` takes the effect.

```ts continue
const unboundCommand = Upload.run(Effect.succeed("receipt_1"));
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

`op.run` is the raw command: it writes nothing to the field and issues under
every mode, `"first"` included. The handler of the triggering action returns
it, so the effect's `R` reaches the feature's service requirements.

### `cancel`

```ts continue
const stop = loadMail.cancel; // Command.cancel("Task/LoadMail")
```

`cancel` writes nothing to the field. A field left `Pending` after a cancel
stays `Pending`, so on the manual path the handler that returns `cancel` also
resets the field, as `ManualMailbox`'s `Cancelled` handler does.

### `into`

```ts fragment
into: <Key extends string>(key: Key) => TaskHandlers<Name, Key, Success, Failure>;
```

`into(key)` returns the two settle handlers, keyed by the operation's own
tags, spread into the reducer:

```ts continue
const viaInto = ManualMailbox.reducer({
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
const byHand = ManualMailbox.reducer({
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

The manual-path settle handler for a result that means more than the field
write. `resolvedInto(key, then)` is a `${Name}Resolved` handler: it writes
`Task.resolved(value)` into `snapshot.draft[key]`, then calls `then` with the
value and the same snapshot. `then` returns the draft, alone or beside a
command. `rejectedInto` is the same for `${Name}Rejected` with
`Task.rejected(error)`.

The entry is written in its key's position, after `...into(key)` for the
other side, which is what gives `snapshot` and a command's `dispatch` the
feature's own types. `manualMailbox` counts the subjects this way; `manual`
above shows `count: 1`.

The follow-up may return a command beside the draft.

```ts continue
const reported: Array<string> = [];

const reporting = ManualMailbox.create({
  initialState: ManualMailbox.initialState(() => ({ folder: "", subjects: Task.idle, count: 0 })),
  reducer: ManualMailbox.reducer({
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
  render: ManualMailbox.render(() => null),
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
const spreadAfterWrite = ManualMailbox.create({
  initialState: ManualMailbox.initialState(() => ({ folder: "", subjects: Task.idle, count: 0 })),
  reducer: ManualMailbox.reducer({
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
  render: ManualMailbox.render(() => null),
});

spreadAfterWrite.reduce(
  { _tag: "LoadMailResolved", value: ["Hello"] },
  { state: { folder: "inbox", subjects: Task.pending, count: 0 }, props: {}, hooks: {} },
);
// throws TypeError: handler wrote into snapshot.draft and returned a different state
```

## `Task.output`

```ts continue
const announceUpload = Task.output("Announce", { success: Schema.String });

const Announcer = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ note: Schema.String }),
  actions: actions.Opened,
  outputs: announceUpload,
});

console.log(Object.keys(announceUpload).sort());
// => ["Rejected", "Resolved", "actions", "cancel", "run", "schema"]
```

The same operation with both actions on the outbound channel, so it goes into
the `outputs` slot. They leave through `onAnnounceResolved` and
`onAnnounceRejected` and never reach the reducer, so the operation has no
field, no place in the `tasks` slot, and no `into`, `resolvedInto` or
`rejectedInto`.

## The group

Every mode books fibers under `` `Task/${Name}` ``, so `cancel` addresses them
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
nothing: `cancelledRun` above emitted `[]`, and a take-latest interruption
leaves no rejection behind either.

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
fills on the manual path is declared with that operation's [`schema`](#schema).

```ts continue
const State = Schema.Struct({
  subjects: Task.schema(Subjects),
  upload: Task.schema(Schema.String, NotFound),
});
```

The handlers are what connect such a field to an operation.

### `Task.idle` and `Task.pending`

```ts continue
const initial: TaskValue<ReadonlyArray<string>, string> = Task.idle;
console.log(Task.idle);
// => { _tag: "Idle" }
console.log(Task.pending);
// => { _tag: "Pending" }
```

`Task.idle` is the initial value for a field: the `tasks` slot fills its
fields with it, and a manual-path `initialState` writes it. `Task.pending` is
written on the fold that issues the command, so a button is already disabled
when the click handler returns.

### `Task.start`

```ts fragment
Task.start<State, Key extends TaskKeys<State>, Action, R>(
  state: State,
  key: Key,
  command: Command<Action, R> | LazyCommand<State, Action, R>,
): readonly [State, Command<Action, R> | LazyCommand<State, Action, R>]
```

The manual-path start. `Task.start` returns one tuple: the state with
`Pending` written into `key`, and the command. `key` is constrained to the
state's own `TaskValue` fields, so a typo is a compile error.

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
fold finishes it like any other write. `manualMailbox`'s `Opened` handler does
this.

```ts continue
const openedFromDraft = manualMailbox.reduce(actions.Opened.make({ folder: "inbox" }), {
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

The two constructors a settle writes.

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
