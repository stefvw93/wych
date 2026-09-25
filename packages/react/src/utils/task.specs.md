# task.ts — async work as two actions, one command, and a four-case field

## Overview & Purpose

The generic form of "kick off some work, then fold what it produced", split
into the two halves it actually has:

- **The operation** — `Task(name, { success, failure?, onError?, mode?, run? })`
  declares two actions (`${Name}Resolved`, `${Name}Rejected`) and the command
  that produces them. It owns the _work_: scheduling it, interrupting it,
  turning however it ended into one of two actions. `Task.output` is the same
  operation announced rather than folded.
- **The binding** — `define({ tasks: { save: saveNote } })` gives the
  operation a field of its own under the key. The key adds a `TaskValue`
  field to `State`, and the fold writes it: `Pending` from
  `snapshot.tasks.save.start(input)`, `Idle` from `.cancel()`, the settled
  value before any settle handler runs.
- **The value** — `TaskValue<A, E>` is `Idle | Pending | Resolved { value } |
Rejected { error }`, with `Task.schema` for the field, constructors, a total
  `match` for render, partial reads and guards for everywhere else, and
  `Task.start` to write `Pending` beside a command.

The slot is the default path. The manual path stays for work stored
somewhere other than one field: the operation in the `actions` slot, a
`Task.schema` field, `Task.start` / `op.run` to start it, and `into(key)` /
`resolvedInto` or a hand-written entry to settle it. On that path nothing
connects the operation and the field but the handlers the feature writes or
spreads in, so the field is declarable before the operation exists and an
operation is declarable for a feature that stores nothing.

**One namespace, deliberately.** `Task` holds both a constructor for operations
and functions over values, the way `Effect`, `Schema` and `Option` each hold
constructors and operators under one name. The operation is used through
methods (`search.run(params)`, `search.cancel`) because that is how a declared
thing is used elsewhere in the library — `SetMode.make(payload)`,
`Schema.Struct(…).make`. The value is used through data-first functions
(`Task.match(v, …)`, `Task.value(v)`) because they are functions over data,
exactly as `Option.match(o, …)` is. See Deferred decisions for the two
alternatives considered.

## The value — four cases, not two booleans

`isPending: boolean` plus `data?: T` can represent "pending _and_ resolved",
and leaves a rejection with nowhere to go. Four tagged cases cannot.

`Pending` deliberately carries no previous `value`. A refetch that keeps the
last result readable needs a fifth case (`Refreshing { value }`), which is
additive if it ever lands. Rendering stale data as fresh is the failure that
silently ships; an empty flash is the one you notice.

`match` is total — four arms, no `orElse` — because a render forgetting a case
should be a compile error, not a blank screen. Its result is the _union_ of the
arms' returns, read off the arms rather than inferred as one `Out`: inferring
one `Out` across four arms picks the first candidate and rejects the rest, so a
`Pending` arm returning a string beside a `Resolved` arm returning an element
would not compile.

Everywhere that is not a render wants one case, not four. `Task.value(v)` and
`Task.error(v)` return `Option`; `Task.getOrElse(v, () => fallback)` collapses
the rest; `Task.isIdle` / `isPending` / `isResolved` / `isRejected` are type
guards, so a branch on one narrows the field.

`Task.schema(success, failure = Schema.String)` builds the field's schema. It
is `schema`, not `slice`: "slice" is Redux vocabulary for a state sub-tree,
and this returns a schema for one field.

## The `tasks` slot — the task owns its field

Starting a task by hand repeats its field key in the state schema, in
`initialState`, in every `Task.start` and in `into`, and nothing ties the
operation to the field. Three failures come from that: a `cancel` that does
not clear the field leaves it `Pending` for good; take-first is a guard
written in every handler that starts the task; and `run` without
`Task.start` never shows the loading state. The slot declares the binding
once:

```ts
const Editor = define({
  props,
  state: Schema.Struct({ text: Schema.String, dirty: Schema.Boolean }),
  tasks: { save: saveNote },
  actions,
  outputs,
});

Editor.create({
  initialState: (p) => ({ text: p.initialText, dirty: false }),
  reducer: {
    SaveClicked: (_p, { state, props, tasks }) =>
      tasks.save.start({ id: props.noteId, text: state.text }),
    Cancelled: (_p, { tasks }) => tasks.save.cancel(),
    SaveResolved: ({ value }, { draft, props }) => {
      draft.dirty = false;
      return [draft, Command.output(outputs.Saved, { id: props.noteId, revision: value })];
    },
  },
  render,
});
```

**`define({ tasks })`** takes a record of internal `Task` operations. Each key
adds a `TaskValue<Success, Failure>` field to `State`, typed by `op.schema`,
and the operation's two actions to the action union. The runtime extends the
state schema with `op.schema` under the key. `initialState` is typed without
the task keys; the runtime fills each with `Task.idle` and spreads the
feature's state on top, so a feature that returns a task key anyway sets it.

**Settle.** The reducer's `${Name}Resolved` / `${Name}Rejected` keys are
optional for a slot task. The fold writes `Task.resolved(value)` /
`Task.rejected(error)` into the field through a draft of its own, and folds
the handler, when there is one, over that state. The handler's
`snapshot.state` and `snapshot.draft` already hold the settled field, so:

- returning the draft (alone or with a command) returns the field write plus
  what the handler wrote;
- returning `snapshot.state` unchanged returns the field write alone, which
  keeps a no-op handler a no-op;
- writing into the draft and returning another state is the fold's draft
  `TypeError`, as in every handler.

A settle handler receives the action's payload (`{ value }` / `{ error }`),
like every other handler.

**`snapshot.tasks.<key>`** is a prototype getter on the fold's snapshot, lazy
like `draft`, and present on reducer snapshots only, lifecycle handlers
included. `render` and `subscriptions` have no handles: neither changes
state.

- `start(input)` writes `Pending` into the draft and returns
  `[draft, op.run(input)]`. Its command carries the operation's `R`, so
  `ServicesOf` reads it off the handler's return. An operation declared
  without `run` has a `start` that takes the effect.
- `start` leaves a field that is already `Pending` untouched, so a start
  that writes nothing else finishes to `snapshot.state` itself.
- `cancel()` writes `Idle` and returns `[draft, op.cancel]`.
- A handler may write other draft fields before or after calling either;
  the handle returns the same draft.

`op.Resolved` / `op.Rejected` are the two message schemas by name, so a test
seeds `saveNote.Resolved.make({ value })`.

**Clash rules.** Each throws a `TypeError` at `define`, and each is a compile
error where the types can express it:

1. A task key equal to a state field (`NoTaskCollision`, the shape of
   `NoPropCollision`).
2. A task tag equal to a declared action or output tag (`Disjoint` over the
   declared tags and the task tags). The runtime reuses the duplicate-tag
   check.
3. One operation under two keys: by identity at runtime; at type level
   through the tags the two keys share (`NoDuplicateTaskTags`), which also
   catches two operations of one name.
4. One operation in both `tasks` and `actions`: its tags collide, so rule 2
   catches it on both levels.
5. A `Task.output` operation in `tasks`: the slot takes operations whose
   binding is on the internal channel, and the runtime reads the channel.

A value in the slot that is not a `Task` operation throws too.

**Placement.** `subscriptions` stays on `create`: it is a function of the
snapshot, re-evaluated per fold. The task binding is a static declaration,
like the state schema and the vocabularies, so it goes on `define` beside
them, and `initialState`, the reducer and the snapshot types all read it.

**Headless tests are unchanged.** `run` and `reduce` take the same arguments
and return the same results; the task field is part of `State`. A test that
builds a state by hand includes `save: Task.idle`.

## The manual path — the operation in `actions`

For work stored somewhere other than one field, the operation goes into the
`actions` slot, and the feature writes the field. The reducer is total over
the action union, so the two settle handlers cannot be forgotten; what they
do in the common case is fixed, so the operation writes them:

```ts
...search.into("search"),
```

`into(key)` returns `{ SearchResolved, SearchRejected }`, each writing
`Task.resolved(value)` / `Task.rejected(error)` into `key` and spreading the
rest of the state. The handlers are generic over the state, because the
operation does not know the feature's `State`: `create`'s `U extends Reducer`
unifies the type parameter with `State` where they are spread in, so a key
that is not a `TaskValue<Success, Failure>` field of that state (missing, not
a task field, or a task field of other types) is a compile error at the
spread site. An optional field is accepted, as `Task.start` accepts one.

The hand-written entry stays the extension point. An explicit key written
after the spread replaces the generated handler (an object literal keeps the
last spelling of a key), so a handler that selects the first hit or clears a
filter is written as before, and only for the tag that needs it:

```ts
...search.into("search"),
SearchResolved: (action, { state }) =>
  ({ ...state, first: action.value[0], search: Task.resolved(action.value) }),
```

The earlier objection to generated handlers was collision with a hand-written
one; spread-then-override is the resolution. `into` never derives anything
beyond the field write; that is what the override is for. An announced
operation (`Task.output`) has no `into`: an output has no reducer handler.

**`Pending` is written on the fold that issues the command**, not dispatched by
it. A dispatched `Pending` would paint a microtask later — exactly long enough
to double-submit. `Task.start(state, key, command)` is the one-liner that makes
the write and the command inseparable; `key` is constrained to the state's own
`TaskValue` fields, so a typo is a compile error rather than a field that stays
`Idle`. Since the lazy-command pass, `command` may be `(next) => op.run(next)`
or point-free `op.run` when the operation takes the state; the thunk receives
the state with `Pending` already written.

**Concurrency is a property of the operation**, declared once: `mode:
"latest"` (default — interrupt the running fiber, run the new one), `"every"`
(run both; last to settle wins, which is usually a bug — declare it
deliberately) or `"first"` (keep the running one, drop the new start).
`"first"` is decided where the work is scheduled, not in the fold: the
command is a `Keyed` node flagged `first`, and the interpreter skips it while
a fiber is booked under the operation's group on that mount. It therefore
holds for every path (the slot's `start`, `op.run`, `Task.start`,
`Task.output`), and a run that ended without settling (a raw `cancel`, an
unmount, a teardown past its deadline) never blocks the next start. The
field cannot tell that a run is gone; the fiber book can.

**Failure is total.** `onError: (cause: Cause<unknown>) => Failure` receives
the whole `Cause` — typed failures and defects alike — so a genuine bug inside
the effect lands in the field as a rejection rather than reaching the `Error`
lifecycle. A mapping that cares can tell `Cause.hasDies` from a 404. Without
a `failure` schema the field's error is a string and `onError` defaults to
`Task.errorMessage`, the mapping that pairs with it; nearly every task wrote
that pairing out by hand. Declaring a `failure`, even `Schema.String`, is
declaring a shape the default cannot be trusted to produce, so `onError` is
required with it. One cause it never sees: **interruption**. Take-latest and
`cancel` end work on purpose, and "you cancelled it" is not an error the UI has
to render — a cancelled operation dispatches nothing at all.

**`run` is bound or unbound.** Declaring `run: (input) => Effect` in the config
binds the work to the operation: the effect is written once beside the schemas
that describe what it yields, and the operation's `run` takes the input. Omit
it and the operation's `run` takes the effect, for work that genuinely differs
per call site; its `R` then flows to `ServicesOf` from the call. A bound
`run` that takes no input pins `Input` to `void` through its own constructor
overload, so the call is `op.run()`; inferred through the generic form a
zero-parameter function would give `Input` no candidate, collapse to `never`,
and read as unbound.

**The fiber group is `Task/${Name}`**, namespaced against the flat per-mount
namespace `lib.specs.md` describes: an unkeyed command books under its issuing
action's tag, so a feature with an action tagged `WallhavenSearch` and an
operation of the same name would otherwise interrupt each other. `cancel` is
`Command.cancel("Task/Name")` — a bare command, so a handler can invalidate work
another action started. `op.cancel` writes nothing; a cancelled operation left
`Pending` is a permanently disabled button, so on the manual path the handler
clears the field in the same return. The slot's `cancel()` is that return.

## Acceptance Criteria

`[x]` holds today; every line below is pinned by `task.test.ts` or
`task.tst.ts`.

### The value

- [x] `TaskValue<A, E>` is exactly `Idle | Pending | Resolved { value: A } | Rejected { error: E }`; `Pending` carries no value.
- [x] `Task.schema(success)` is a `Schema.TaggedUnion` with cases `Idle`, `Pending`, `Resolved`, `Rejected`, with `Schema.String` as the failure; `Task.schema(success, failure)` takes an explicit failure schema, and both `onError` and the field are typed by it.
- [x] `Task.idle` and `Task.pending` are frozen constants; `Task.resolved(value)` and `Task.rejected(error)` construct the other two. All four are assignable to the field `Task.schema` declares, and the success type is not erased — `Task.resolved(1)` does not fill a `string` field.
- [x] `Task.match(value, cases)` is total: each of the four arms is required, each is handed its whole member, the result is the union of the arms' return types, and a missing arm is a compile error.
- [x] `Task.value(v)` is `Option.some(value)` for `Resolved` and `Option.none()` otherwise; `Task.error(v)` likewise for `Rejected`; `Task.getOrElse(v, orElse)` returns the value for `Resolved` and `orElse()` otherwise, typed `A | Fallback`.
- [x] `Task.isIdle` / `isPending` / `isResolved` / `isRejected` are type guards: a branch on one narrows the field to that case, with `value` / `error` typed by the field's schemas.
- [x] `Task.start(state, key, command)` returns `[{ ...state, [key]: Pending }, command]`; `key` is constrained to the keys holding a `TaskValue`, optional keys included.
- [x] `Task.start` accepts a lazy command, and hands it the state with `Pending` written — its parameter is the narrowed state actually passed, not the feature's declared `State`.

### The operation

- [x] `Task(name, …)`'s own keys are exactly `{ Resolved, Rejected, actions, run, cancel, into, resolvedInto, rejectedInto, schema }` — no `field`, `initial`, `handlers`, `idle`, `start`, `match`, `get` or `reset`. `schema` describes the field; the slot is what writes it.
- [x] `op.Resolved` and `op.Rejected` are `actions[0]` and `actions[1]`; `op.Resolved.make({ value })` builds the action a test seeds.
- [x] `op.schema` is `Task.schema(success, failure)` of the operation's own schemas, `Schema.String` failure when none was declared.
- [x] Without `failure`, `onError` may be omitted and is `Task.errorMessage`. With `failure`, `onError` is required, `Schema.String` included.
- [x] `into(key)` returns `{ ${Name}Resolved, ${Name}Rejected }`, in that key order; `Resolved` returns `{ ...state, [key]: Task.resolved(value) }`, `Rejected` returns `{ ...state, [key]: Task.rejected(error) }`, and folded through `feature.run` the field lands exactly as with hand-written handlers.
- [x] An explicit handler written after `...op.into(key)` replaces the generated one for that tag; the other generated handler still stands.
- [x] `op.resolvedInto(key, then)` is a `${Name}Resolved` handler: it writes `Task.resolved(value)` into `snapshot.draft[key]`, then returns `then(value, snapshot)` with the same snapshot, so what `then` writes lands beside the field and a returned draft is the one finished state. `op.rejectedInto` is the same for `Rejected`. `snapshot.state` returned alone or as a tuple's first element becomes the draft, so it finishes with the field written; any other returned state is the fold's draft `TypeError`; a lazy command beside the draft sees the finished state. An announced operation has neither.
- [x] `actions` is `[${Name}Resolved { value: Success }, ${Name}Rejected { error: Failure }]`. The operation itself goes into `define`'s slot (`actions: [Clicked, search]`), and so does `...op.actions` inside an array.
- [x] A lower-case `name` is a compile error, on the same terms as an action tag.
- [x] The effect's success dispatches `${Name}Resolved` with the value, and lands in whatever field the handler writes.
- [x] A typed failure passes through `onError` and dispatches `${Name}Rejected`; a **defect** passes through `onError` too — nothing reaches the `Error` lifecycle handler.
- [x] `Task.errorMessage` is the `Error`'s message, or its `name` when the message is empty — the tag, for a `Schema.TaggedError` declared without a `message` field. It does not read `cause`: which layer's text the UI wants is the app's decision, made in `onError`. A non-`Error` is `String(error)`.
- [x] Interruption dispatches nothing: a second `run` under `"latest"` interrupts the first and yields exactly one `Resolved`, carrying the second's value.
- [x] Under `"every"` both runs go to completion and both emit.
- [x] Under `"first"`, a second run while the first is in flight is dropped where it is scheduled: on the manual path, through `op.run`, and for a `Task.output` operation, each emits one settle.
- [x] Under `"first"`, a run interrupted without settling (the raw `op.cancel`, leaving the field `Pending`) does not block the next start, on the manual path and in the slot.
- [x] Under `"first"`, a start from `Mounted` after `stop` / `start` (the StrictMode remount) books a run on the new mount and settles the field.
- [x] `cancel` is `Command.cancel("Task/${Name}")` — `_tag: "Cancel"`, a bare command — and interrupts the in-flight work without emitting.
- [x] `Pending` is written synchronously on the fold that issues the command: `feature.reduce(Clicked, snapshot)` already shows `Pending` in the returned state.
- [x] With `run` declared, the operation's `run` takes that input and only that input; the effect declared receives it.
- [x] Without `run`, the operation's `run` takes an effect and carries its `R` to `ServicesOf`, so a service the effect needs is still a compile error at `component`.
- [x] `Task.output(name, …)` has the same shape with both actions on the outbound channel: results land in `run`'s `outputs`, never in state, and a rejection is announced the same way. It has no `into`.

### The `tasks` slot

- [x] `run` with no seeds reports each task field as `Task.idle`, under the feature's initial state; a task key the feature's `initialState` returns anyway wins.
- [x] `tasks.<key>.start(input)` returns a state with `Pending` in the field, from `feature.reduce`; through `run`, the settle lands in the field with no settle handler, `Resolved` and `Rejected` alike.
- [x] A seeded `op.Resolved.make({ value })` / `op.Rejected.make({ error })` folds into the field with no handler.
- [x] A settle handler sees the settled field in both `snapshot.state` and `snapshot.draft`, and what it writes into the draft lands beside it.
- [x] A settle handler returning `snapshot.state`, alone or with a command, returns the field write alone; one that writes into the draft and returns `snapshot.state` throws the fold's draft `TypeError`.
- [x] `tasks.<key>.cancel()` returns `[state with Idle, op.cancel]`; through `run`, a start then a cancel emits nothing and leaves `Idle`.
- [x] A handler that writes other draft fields before and after a handle call returns one state holding all the writes.
- [x] An unbound operation's `start` takes the effect.
- [x] Under `mode: "first"`, `start` while the field is `Pending` returns `snapshot.state` by identity beside the operation's `Keyed` command flagged `first`; through `run`, two starts emit one settle. A start after the settle runs again.
- [x] A reducer snapshot's own keys stay `state`, `props`, `hooks`; a feature without `tasks` hands `snapshot.tasks` as `{}`.
- [x] `define` throws a `TypeError` for a task key that is a state field, a task tag declared in `actions` or `outputs`, one operation under two keys, two operations of one name, one operation in both `tasks` and `actions`, a `Task.output` operation, and a value that is not a `Task` operation.
- [x] In a browser, a click that starts a slot task paints `Pending`, a cancel paints `Idle`, and the settle paints `Resolved` (`lib.browser.test.tsx`).

### Type-level (TSTyche) — `src/__type-tests__/task.tst.ts`

- [x] `Task(…)` has no `field` / `initial` / `handlers` / `idle` / `start` / `match` / `get` / `reset` property.
- [x] `Task("search", …)` does not compile; `Task("Search", …)` does.
- [x] `"first"` is a mode beside `"latest"` and `"every"`; any other string is not.
- [x] `op.Resolved.make(…)` / `op.Rejected.make(…)` return the two action types, and `op.Resolved` is `op.actions[0]`.
- [x] `define({ tasks })`: `State` is the schema's fields plus one `TaskValue` per key; `initialState` compiles without the task keys; a hand-built state for `reduce` includes them.
- [x] The settle keys are optional; a written one gets its payload (`value` / `error`) and `draft.<key>` typed, keeps the contextual command type, and an excess state key is still reported. A declared action is still required.
- [x] `tasks.<key>.start` takes the operation's input (a wrong input does not compile), in both `create({ reducer })` and `Definition.reducer`; its `R` reaches `ServicesOf`, and `run` without the service layer does not compile.
- [x] An unbound operation's `start` takes an effect of the success type; `ServicesOf` is `never` for a pure effect and names the service of one that needs it.
- [x] Lifecycle handlers get the handles; a feature without `tasks` has `snapshot.tasks: {}` and its state type unchanged.
- [x] The clash rules: a task key that is a state field, a task tag that is a declared output tag, one operation under two keys, one operation in both `tasks` and `actions`, and a `Task.output` operation do not compile; two distinct operations under two keys do.
- [x] Bound `run` is callable with its input and not with an effect; unbound `run` is callable with an effect and not with an input, and `ServicesOf` of a reducer using it names the effect's service.
- [x] A bound `run` declared with no parameter is callable with no argument, and with neither an input nor an effect; its `R` still comes from the declared effect.
- [x] `Task.schema(Schema.String)`'s `Type` is the four-case union with `string` value and `string` error; with an explicit failure schema the error takes its `Type`.
- [x] `match` result type is the union of the arms; three arms do not compile.
- [x] `Task.value` / `error` / `getOrElse` are typed by the field; the guards narrow `value` / `error` inside the branch.
- [x] `op.schema`'s `Type` is the field `Task.schema` of the same schemas declares.
- [x] `Task(name, { success })` compiles with no `onError`, bound, unbound and zero-input alike; with `failure` (any schema) and no `onError` it does not.
- [x] `Task.output(…)`'s `run` and `cancel` are `Command<TaskAction<…>>` — the same types as the folded form; it has no `into` property.
- [x] `...op.into(key)` spread into `Definition.reducer` compiles, the reducer stays exhaustive, and `ServicesOf` of it is `never`.
- [x] `into("notAField")`, `into` of a non-`TaskValue` field, and `into` of a `TaskValue` field whose success type differs from the operation's do not compile at the spread site; the matching key does.
- [x] `into` addresses a field declared `Schema.optional(Task.schema(…))`.
- [x] An explicit handler after the spread is typed by the action's payload (`value` is the success `Type`).
- [x] Written as a reducer entry, `resolvedInto`'s `then` gets the feature's `ReducerSnapshot` (props, draft) and the value by context, a command in it keeps the contextual `A`, its `R` reaches `ServicesOf`, a side written without one leaks no `any`, a key that is not the operation's `TaskValue` field is rejected, and an excess state key is still reported.
- [x] `Task.start` with a thunk types the thunk's parameter as the passed state, and `Next.command` of the result is `Command<TaskAction<…>> | undefined`.

## Technical Requirements

- Depends on `lib.ts` only: `Action` / `Action.output` for the two messages, `Command.effect` / `keyed` / `restart` / `cancel` for the work, `LazyCommand` for `start`'s thunk form, `Message` for the action types, and `bindTask` / `TaskBinding` / `TaskCarrier` for the slot.
- `lib.ts` does not import `task.ts`. Each operation carries a `TaskBinding` under a `lib.ts` symbol, attached by `bindTask` as `carryMembers` attaches the members: the two tags, `run`, `cancel`, `idle` / `pending`, and the `resolved` / `rejected` constructors. Its type parameters carry the field type, the success type, the two actions, the input, `R` and the channel, which is everything `TaskFields`, `TaskActionsOf` and `TaskHandle` read.
- `AnyTaskOperation` has `never` in the input position: a bound operation's `run` is `(input: I) => …`, and only a function over `never` is a supertype of all of them. The `infer` patterns over a binding use `never` there for the same reason.
- `TaskActionsOf` reads the actions off the binding, not through `MembersOf`: `MemberOf` recurses, and over the generic `TS[keyof TS]` inside `define`'s parameter it does not bottom out.
- An unbound `start` defaults `E` and `R2` to `never`, so an effect whose `R` is `never` infers `never` rather than falling back to `unknown`.
- `TaskSchema` is `Schema.TaggedUnion`, not `Schema.Union(...).pipe(Schema.toTaggedUnion)`: the latter constrains members to `{ Type: { _tag } }`, which TypeScript cannot prove for `TaggedStruct<Tag, Fields>` while `Fields` is a type parameter — `Struct<F>["Type"]` is a stack of mapped types that will not reduce until `F` is concrete.
- `TaskMessage` intersects `Message<…>` with `{ Type: { _tag: Tag } }` for the same reason: a slot reads each member's `Type` for its `_tag`, and the intersection hands TypeScript the proof it cannot compute.
- `` `${Name}Resolved` `` is `` `${string}Resolved` ``, which does not satisfy `Capitalize<string>`; `ResolvedTag<Name>` re-applies `Capitalize` to the joined string.
- The work is `effect.pipe(flatMap(dispatch Resolved), catchCause(hasInterruptsOnly ? void : dispatch Rejected(onError(cause))))`, so the command's error channel is `never` — which `Command.effect` requires anyway — and interruption is the one cause that dispatches nothing.
- `"latest"` is `Command.restart(group, work)`, `"every"` is `Command.keyed(group, work)`, and `"first"` is `keyedFirst(group, work)`: a `Keyed` node with `first: true`, which the interpreter skips while its address has a booked fiber. All book under the group, so `cancel` addresses them all; only `latest` also interrupts what is running.
- Internally the command is built as `Command.effect<any, unknown>`; the operation's declared `run` type restores `R` — from the bound effect's declaration, or from the effect passed to an unbound `run`.
- `Task.errorMessage` is `Cause.squash` then `error instanceof Error ? error.message : String(error)`.
- The guards and partial reads take `TaskValue<A, unknown>` / `TaskValue<unknown, E>`, which every concrete field is assignable to under readonly covariance.
- `into`'s handlers are `<S extends { readonly [K in Key]?: TaskValue<Success, Failure> }>(payload, { state: S }) => S`. Assignability to a `Reducer` slot instantiates `S` from `Snapshot<Props, State, H>`, so `S = State`; `Exhaustive`'s `infer N` and `ServicesOf`'s `ReturnType` read the base signature, i.e. the constraint, which has no key beyond `Key` and is no command tuple, so both stay `never`. A wrong key surfaces as `Exhaustive`'s `state has no property …` message. `TaskOperation` is a conditional alias: `TaskOperationBase & TaskInto` on the internal channel, `TaskOperationBase` alone on the outbound one, so `into` is structurally absent rather than typed `never`.

## Expected Behavior & Edge Cases

- **Two operations with one name in one feature share a group.** The group is derived from the name, so their `cancel`s and their take-latest interrupt each other. Same rule as the flat namespace in `lib.specs.md`: one name, one meaning — not a collision the library defends against.
- A user `Command.keyed("Task/Search", …)` books under the operation's group deliberately, and the operation's `cancel` reaches it. Same rule.
- `"every"` has no ordering: two runs that resolve out of order write the field in arrival order, and the last write wins. That is what "declare it deliberately" means.
- `op.cancel` leaves `Pending` in place; on the manual path the handler that returns it clears the field in the same return, or the button stays disabled. The slot's `cancel()` clears it.
- `mode: "first"` reads the fiber book, not the field: a handler that wrote `Pending` itself before calling `start` still starts the work when nothing is in flight.
- Under `"first"`, a fiber interrupted but still winding down in an uninterruptible region is booked until it exits, so a start in that window is dropped.
- Under `"first"`, a remount books on a new mount with an empty book, so the new mount starts its own run while the old one drains or is interrupted. Both may settle the field; the later settle wins.
- A settle for a task whose field the handler of another action has since overwritten still writes the field: the fold does not compare the settle against what the field holds.
- The default `Task.errorMessage` turns a defect into its message string, indistinguishable in the field from a typed failure. Pass a failure schema and an `onError` that reads `Cause.hasDies` when the UI should tell them apart.
- `Task.start` through a raw tuple (`[state, thunk]` written by hand, without `start`) types the thunk's parameter as the feature's `State`, not the narrowed literal — the contextual type is the handler's return. `Task.start` infers from its first argument and does narrow. Pinned in `core.tst.ts`.

## Known limitations

- **`into` on an empty state.** A `State` of `Schema.Struct({})` has no properties, so the weak-type check that rejects `into("anything")` against it does not fire and the spread compiles. A feature with a task field is never in this position; recorded, not guarded.

- **No `Refreshing` case.** Stale-while-revalidate — keep the last value readable while a refetch is pending — is not expressible; `Pending` empties the field. The fix is a fifth case, additive to the type, a fifth arm in `match`, and a decision about which of `value` / `isPending` reflect it. Recorded under Deferred decisions.
- **`match`'s arm-union result needs an object literal at the call site.** A `cases` value pre-typed as `TaskCases<A, E, Out>` collapses to that one `Out` — which is what the node test does, and what a shared set of arms would do.
- **The operation is one shot per name.** There is no per-call key: two concurrent searches for different queries under one operation are one group, and `"latest"` cancels across them. A keyed variant (`run(input, { key })`) would need the group derived per call and `cancel` to take the key.
- **Not observable as a task in devtools.** The stream shows the issuing action's `Command` event with a `Keyed`/`Batch` summary naming `Task/Name`, and the `Resolved`/`Rejected` transitions with `cause: { _tag: "Command", key: "Task/Name" }`. Enough to follow; there is no task-level event and none is planned.

## Open work

None with a decision made. The two candidates are recorded below as deferred
rather than left as unchecked boxes.

## Deferred decisions

### `into(key, { resolved, rejected })` follow-ups — rejected for the entry form

The first shape put the follow-ups on `into` itself, spread as today. Rejected
by a type prototype against `define().create()`: an object spread is not
contextually typed by the reducer's `Reducer<…>` constraint, so `snapshot`
fell back to the generic's own constraint (`{ state: TaskField }`) and had no
`props` or `draft`. A call written as a property's value is contextually typed
by that property, so `resolvedInto(key, then)` in the `${Name}Resolved`
position infers `then`'s snapshot from the reducer and its whole return `N`
from the body, and `ServicesOf` reads the real tuple off it. That is why the
name is repeated as the entry's key: the key is where the type comes from.

### Data-first `Task.run(op, input)` — rejected

Considered as the Effect-style dual form. Rejected: `op.run(x)` mirrors
`Action.make(x)` and `Schema.Struct(…).make`, the library's own idiom for using
a declared thing; point-free `op.run` composes with `Task.start` and lazy
commands better than `Task.run(op)` would; and the data-first/data-last dual
exists in Effect for `pipe`, which nothing here flows through. The value-side
functions are data-first already, and correctly so.

### Splitting the value half into its own namespace — rejected

`TaskValue.match`, `TaskValue.idle`, … beside `Task(…)`. Rejected on the same
precedent: one namespace per concept, as `Effect` and `Schema` do. The only
cost kept is that the type is `TaskValue` while the namespace is `Task` — the
same asymmetry as `Schema.Struct(…)` → `Schema.Struct<F>`.

### `Refreshing { value }` — deferred

Additive when wanted. Needs decisions on `match` (fifth mandatory arm, or
`Refreshing` folded into `Pending` with an optional value), on whether
`Task.value` reports the stale value, and on whether `Task.start` writes it
from the previous `Resolved`. Not until a feature needs it.

### Modelling the settled half as Effect's `Result` — deferred

`Idle | Pending | Result<A, E>` would reuse Effect's constructors and `match`.
Costs a third naming style in one type (`Resolved`/`Rejected` are Promise
vocabulary, `Success`/`Failure` are Effect's) and a schema question for the
`Result` half. Not now.

## Browser coverage (`/e2e`)

One test: `lib.browser.test.tsx` mounts a feature with a slot task and checks
that a start and a cancel from real clicks paint, and that the settle paints.
Everything else is observable through `Feature.run` headlessly, and
`task.test.ts` drives it that way. The consumer this was written against (`apps/frontend/src/features/seed`)
lived in a repo this package has since left. The in-repo consumers are the
docs — `reference/tasks.md` and the how-to pages that use `Task`, executed by
`docs:check --run` — and the examples under `docs/examples/*` built from them.
The partial reads (`value`, `error`, `getOrElse`) and the other guards are
covered by the node and type tests alone.
