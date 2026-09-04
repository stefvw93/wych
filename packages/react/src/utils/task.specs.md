# task.ts — async work as two actions, one command, and a four-case field

## Overview & Purpose

The generic form of "kick off some work, then fold what it produced", split
into the two halves it actually has:

- **The operation** — `Task(name, { success, failure?, onError, mode?, run? })`
  declares two actions (`${Name}Resolved`, `${Name}Rejected`) and the command
  that produces them. It owns the _work_: scheduling it, interrupting it,
  turning however it ended into one of two actions. It writes nothing into
  state. `Task.output` is the same operation announced rather than folded.
- **The value** — `TaskValue<A, E>` is `Idle | Pending | Resolved { value } |
Rejected { error }`, with `Task.schema` for the field, constructors, a total
  `match` for render, partial reads and guards for everywhere else, and
  `Task.start` to write `Pending` beside a command.

Nothing connects the two but the handlers the feature writes. That is the
point: the field is declarable before the operation exists, an operation is
declarable for a feature that stores nothing, and where a result lands is
visible in the file that owns it.

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

## The operation — work, not state

What it deliberately does not have: a state field, an initial value, reducer
entries, or a `start` that writes into state on the feature's behalf. The
reducer is already total over the action union, so the two handlers cost two
lines and cannot be forgotten:

```ts
SearchResolved: (action, { state }) => ({ ...state, search: Task.resolved(action.value) }),
SearchRejected: (action, { state }) => ({ ...state, search: Task.rejected(action.error) }),
```

That is also the extension point an injected version would not have: a handler
that wants to select the first hit or clear a filter writes it in the same
entry, instead of colliding with a spread-in handler for the same tag.

**`Pending` is written on the fold that issues the command**, not dispatched by
it. A dispatched `Pending` would paint a microtask later — exactly long enough
to double-submit. `Task.start(state, key, command)` is the one-liner that makes
the write and the command inseparable; `key` is constrained to the state's own
`TaskValue` fields, so a typo is a compile error rather than a field that stays
`Idle`. Since the lazy-command pass, `command` may be `(next) => op.run(next)`
or point-free `op.run` when the operation takes the state; the thunk receives
the state with `Pending` already written.

**Concurrency is a property of the operation**, declared once: `mode:
"latest"` (default — interrupt the running fiber, run the new one) or
`"every"` (run both; last to settle wins, which is usually a bug — declare it
deliberately). Take-_first_ is not a mode: dropping a start means reading
whether one is already pending, which is a question about the feature's state,
so it is a `Task.isPending` guard in the handler that has the state in hand.

**Failure is total.** `onError: (cause: Cause<unknown>) => Failure` receives
the whole `Cause` — typed failures and defects alike — so a genuine bug inside
the effect lands in the field as a rejection rather than reaching the `Error`
lifecycle. A mapping that cares can tell `Cause.hasDies` from a 404. It is
mandatory in both forms; the `Schema.String` default failure exists to spare a
schema, not the decision, and `Task.message` is the mapping that pairs with it,
spelled out at the call site so a defect quietly becoming a string is something
that was chosen. One cause it never sees: **interruption**. Take-latest and
`cancel` end work on purpose, and "you cancelled it" is not an error the UI has
to render — a cancelled operation dispatches nothing at all.

**`run` is bound or unbound.** Declaring `run: (input) => Effect` in the config
binds the work to the operation: the effect is written once beside the schemas
that describe what it yields, and the operation's `run` takes the input. Omit
it and the operation's `run` takes the effect, for work that genuinely differs
per call site; its `R` then flows to `ServicesOf` from the call. A bound
`run` that takes no input pins `Input` to `void` through its own constructor
overloads, so the call is `op.run()`; inferred through the generic form a
zero-parameter function would give `Input` no candidate, collapse to `never`,
and read as unbound.

**The fiber group is `Task/${Name}`**, namespaced against the flat per-mount
namespace `lib.specs.md` describes: an unkeyed command books under its issuing
action's tag, so a feature with an action tagged `WallhavenSearch` and an
operation of the same name would otherwise interrupt each other. `cancel` is
`Command.cancel("Task/Name")` — a bare command, so a handler can invalidate work
another action started. Cancelling writes nothing; a cancelled operation left
`Pending` is a permanently disabled button, so the handler clears the field in
the same return.

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

- [x] `Task(name, …)` returns exactly `{ actions, run, cancel }` — no `field`, `initial`, `handlers`, `idle`, `start`, `match`, `get` or `reset`. Nothing state-shaped.
- [x] `actions` is `[${Name}Resolved { value: Success }, ${Name}Rejected { error: Failure }]`, spreadable into `Action.of([...])` beside hand-written actions.
- [x] A lower-case `name` is a compile error, on the same terms as an action tag.
- [x] The effect's success dispatches `${Name}Resolved` with the value, and lands in whatever field the handler writes.
- [x] A typed failure passes through `onError` and dispatches `${Name}Rejected`; a **defect** passes through `onError` too — nothing reaches the `Error` lifecycle handler.
- [x] Interruption dispatches nothing: a second `run` under `"latest"` interrupts the first and yields exactly one `Resolved`, carrying the second's value.
- [x] Under `"every"` both runs go to completion and both emit.
- [x] Take-first is a handler guard: `Task.isPending(state.x) ? state : Task.start(…)` drops the second run.
- [x] `cancel` is `Command.cancel("Task/${Name}")` — `_tag: "Cancel"`, a bare command — and interrupts the in-flight work without emitting.
- [x] `Pending` is written synchronously on the fold that issues the command: `feature.reduce(Clicked, snapshot)` already shows `Pending` in the returned state.
- [x] With `run` declared, the operation's `run` takes that input and only that input; the effect declared receives it.
- [x] Without `run`, the operation's `run` takes an effect and carries its `R` to `ServicesOf`, so a service the effect needs is still a compile error at `component`.
- [x] `Task.output(name, …)` has the same shape with both actions on the outbound channel: results land in `run`'s `outputs`, never in state, and a rejection is announced the same way.

### Type-level (TSTyche) — `src/__type-tests__/task.tst.ts`

- [x] `Task(…)` has no `field` / `initial` / `handlers` / `idle` / `start` / `match` / `get` / `reset` property.
- [x] `Task("search", …)` does not compile; `Task("Search", …)` does.
- [x] There is no `"first"` mode.
- [x] Bound `run` is callable with its input and not with an effect; unbound `run` is callable with an effect and not with an input, and `ServicesOf` of a reducer using it names the effect's service.
- [x] A bound `run` declared with no parameter is callable with no argument, and with neither an input nor an effect; its `R` still comes from the declared effect.
- [x] `Task.schema(Schema.String)`'s `Type` is the four-case union with `string` value and `string` error; with an explicit failure schema the error takes its `Type`.
- [x] `match` result type is the union of the arms; three arms do not compile.
- [x] `Task.value` / `error` / `getOrElse` are typed by the field; the guards narrow `value` / `error` inside the branch.
- [x] `Task.output(…)`'s `run` and `cancel` are `Command<TaskAction<…>>` — the same types as the folded form.
- [x] `Task.start` with a thunk types the thunk's parameter as the passed state, and `Next.command` of the result is `Command<TaskAction<…>> | undefined`.

## Technical Requirements

- Depends on `lib.ts` only: `Action` / `Action.output` for the two messages, `Command.effect` / `keyed` / `restart` / `cancel` for the work, `LazyCommand` for `start`'s thunk form, `Message` for the action types.
- `TaskSchema` is `Schema.TaggedUnion`, not `Schema.Union(...).pipe(Schema.toTaggedUnion)`: the latter constrains members to `{ Type: { _tag } }`, which TypeScript cannot prove for `TaggedStruct<Tag, Fields>` while `Fields` is a type parameter — `Struct<F>["Type"]` is a stack of mapped types that will not reduce until `F` is concrete.
- `TaskMessage` intersects `Message<…>` with `{ Type: { _tag: Tag } }` for the same reason: `Action.of` wants a demonstrable `_tag`, and the intersection hands TypeScript the proof it cannot compute.
- `` `${Name}Resolved` `` is `` `${string}Resolved` ``, which does not satisfy `Capitalize<string>`; `ResolvedTag<Name>` re-applies `Capitalize` to the joined string.
- The work is `effect.pipe(flatMap(dispatch Resolved), catchCause(hasInterruptsOnly ? void : dispatch Rejected(onError(cause))))`, so the command's error channel is `never` — which `Command.effect` requires anyway — and interruption is the one cause that dispatches nothing.
- `"latest"` is `Command.restart(group, work)`; `"every"` is `Command.keyed(group, work)`. Both book under the group, so `cancel` addresses them all; only `latest` also interrupts what is running.
- Internally the command is built as `Command.effect<any, unknown>`; the operation's declared `run` type restores `R` — from the bound effect's declaration, or from the effect passed to an unbound `run`.
- `Task.message` is `Cause.squash` then `error instanceof Error ? error.message : String(error)`.
- The guards and partial reads take `TaskValue<A, unknown>` / `TaskValue<unknown, E>`, which every concrete field is assignable to under readonly covariance.

## Expected Behavior & Edge Cases

- **Two operations with one name in one feature share a group.** The group is derived from the name, so their `cancel`s and their take-latest interrupt each other. Same rule as the flat namespace in `lib.specs.md`: one name, one meaning — not a collision the library defends against.
- A user `Command.keyed("Task/Search", …)` books under the operation's group deliberately, and the operation's `cancel` reaches it. Same rule.
- `"every"` has no ordering: two runs that resolve out of order write the field in arrival order, and the last write wins. That is what "declare it deliberately" means.
- `cancel` leaves `Pending` in place; the handler that returns it clears the field in the same return, or the button stays disabled.
- The default `Task.message` turns a defect into its message string, indistinguishable in the field from a typed failure. Pass a failure schema and an `onError` that reads `Cause.hasDies` when the UI should tell them apart.
- `Task.start` through a raw tuple (`[state, thunk]` written by hand, without `start`) types the thunk's parameter as the feature's `State`, not the narrowed literal — the contextual type is the handler's return. `Task.start` infers from its first argument and does narrow. Pinned in `core.tst.ts`.

## Known limitations

- **No `Refreshing` case.** Stale-while-revalidate — keep the last value readable while a refetch is pending — is not expressible; `Pending` empties the field. The fix is a fifth case, additive to the type, a fifth arm in `match`, and a decision about which of `value` / `isPending` reflect it. Recorded under Deferred decisions.
- **`match`'s arm-union result needs an object literal at the call site.** A `cases` value pre-typed as `TaskCases<A, E, Out>` collapses to that one `Out` — which is what the node test does, and what a shared set of arms would do.
- **The operation is one shot per name.** There is no per-call key: two concurrent searches for different queries under one operation are one group, and `"latest"` cancels across them. A keyed variant (`run(input, { key })`) would need the group derived per call and `cancel` to take the key.
- **Not observable as a task in devtools.** The stream shows the issuing action's `Command` event with a `Keyed`/`Batch` summary naming `Task/Name`, and the `Resolved`/`Rejected` transitions with `cause: { _tag: "Command", key: "Task/Name" }`. Enough to follow; there is no task-level event and none is planned.

## Open work

None with a decision made. The two candidates are recorded below as deferred
rather than left as unchecked boxes.

## Deferred decisions

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

Not applicable. The module has no React surface — every behaviour above is
observable through `Feature.run` headlessly, and `task.test.ts` drives it that
way. The live consumer is `apps/frontend/src/features/seed`, whose four
operations (`WallhavenSearch`, `PexelsCurated`, `CreateOmarchyColors`,
`ApplyOmarchyColors`) exercise bound `run`, point-free `Task.start`, `schema`,
the constructors, `match` and `isPending`. The partial reads (`value`, `error`,
`getOrElse`) and the other guards have no frontend caller yet — they are
covered by the node and type tests alone.
