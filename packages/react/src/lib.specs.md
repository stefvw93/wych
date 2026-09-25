# lib.ts — TEA-style feature runtime core

## Overview & Purpose

A **feature** is declared with `define` and built with `create`: schema-typed props and state, a tagged
action vocabulary, an optional outbound output vocabulary (each a message, a
record of messages, a `Task`, or an array of those), optional ambient
hooks, and a reducer. The reducer is pure — it returns the next state and,
optionally, a `Command` describing work to do. The runtime interprets commands
as Effects. A handler builds the next state by hand or through
`snapshot.draft`, a mutable view it writes into and returns (see
"`snapshot.draft`" below); either way the fold receives a plain next state.

Three consumers, one core:

- `feature.reduce(action, snapshot)` — the reducer as one pure function. No
  React, no Effect runtime.
- `feature.run(actions, options)` — folds a sequence to quiescence and reports
  what was emitted. No React.
- `component(feature)` — the React binding, over `createFeatureStore`.

`reduce`, `run` and the store share one command interpreter. Two
implementations of grouping and cancellation would have to agree forever.

## `children`, as an opaque prop

Props are schema values: validated, never decoded — `define` strips any
encoding a field declares with `Schema.toType`, so a transforming schema is
accepted and its decoded `Type` is what the parent passes.
A React node is none of those things — it does not encode, it is a fresh object
on every parent render, and printing one into a devtools event dumps an element
tree. So `children` is _declared_ rather than described:

```ts
const Props = Schema.Struct({ children: Children });
```

`ReactNode` is the default, not a restriction. React lets a component call its
children as easily as render them, so `Children.as<T>()` is the same declaration
at whatever type the feature accepts:

```ts
children: Children.as<(row: Row) => ReactNode>(); // a render prop
```

The type argument is the whole contract — nothing in the runtime reads the
value, so there is no shape for the schema to check and none for it to lie
about.

Required, as written: a feature that cannot render without children says so, and
a call site that passes none is a compile error. `Schema.optionalKey(Children)`
is the optional form. There is no third state — JSX that passes no children (a
comment counts as none) omits the key entirely, so a required `Children` throws
`Missing key` if the type error is ever bypassed.

`Children` is `Schema.declare` with three deliberate properties:

- **It validates anything.** A function's shape is unobservable, `ReactNode` is
  wide and recursive — elements, iterables, thenables — and React already owns
  the question of what it can render. A schema-side re-derivation could only
  disagree with the renderer.
- **It is invisible to change detection.** Its `toEquivalence` annotation is
  constantly `true`, so new children alone never raise `PropsChanged`. Without
  it, a declaration's default equivalence is `Equal.equals` — by reference — and
  every parent render would re-run the reducer.
- **It is redacted in devtools**, to `"<children>"`, by `reportableAction`. Only
  there: `snapshot.props.children` in a reducer is the real node.

The consequence of the second point, accepted: when only children change, the
store keeps its previous `props` object, so a reducer's
`snapshot.props.children` can be the node from an earlier render. `render` is
unaffected — it reads the component's own props, so it always has the current
node. Children are for rendering, not for reducing.

The mechanism is one annotation key, `"@wych/opaque"`, whose value is the
placeholder. `define(...).create` collects the annotated fields off the props
schema once and stores them in the feature's internals; a feature that
declares none pays nothing at the report site. `Schema.optional(x)` is
`optionalKey(UndefinedOr(x))`, so the collection also looks one level into a
union.

`children` is the only opaque prop the library ships. A general
`opaque<T>(placeholder)` combinator — the same mechanism exposed for callbacks,
refs, DOM nodes — was built and withdrawn: the annotation and the collection are
already general, so promoting them is a one-line change if a second caller ever
turns up. Until then the surface says what it means.

Opaque declarations are **props-only, enforced**: redaction covers
`PropsChanged.previous`, while a `Transition`'s state is reported verbatim, so
a state schema declaring `Children` would put raw ReactNodes into every event.
`define` throws on one rather than silently breaking the devtools
encodability contract.

## `useFeature`, the snapshot from inside the subtree

`render` is one function, and a feature whose view is large has nowhere to
split it. A fragment written as its own component needs `state` and `dispatch`
typed to the feature, and the only ways to get them today are by hand through
props, or by promoting the fragment to a feature of its own with outputs —
the right tool for a child _feature_, the wrong one for a paragraph of the
parent's view. `WallhavenInputs` in the frontend is 149 lines for two selects,
an empty state and an empty action vocabulary; the paginator and result grids
in `Seed`'s render stay inline for the same reason.

`component(bp)` therefore hands back an `FC` carrying one hook:

```ts
export const Seed = component(seed, { name: "Seed" });

// a plain React component, anywhere under <Seed>
const Paginator = () => {
  const { state, dispatch } = Seed.useFeature();
  return <PaginationNext onClick={() => dispatch(NextPage.make({}))} />;
};
```

It returns the `RenderSnapshot` — `{ state, props, hooks, dispatch }` — the
exact object `render` was handed on that render. One type for "what the view
can read"; a fragment sees nothing `render` could not.

Design points, each with its reason:

- **It hangs off the FC, not the `Feature` value.** A `Feature`'s public surface is
  `reduce` and `run`, and it knows no runtime. `component` is where React
  enters, so it is where a React hook belongs.
- **The `name` is the scope, and it is required.** The context is looked up
  by `name` in a module-level registry in `lib.ts`. Two calls with two names get two contexts and cannot
  see each other; two calls with one name share one, whatever runtime made
  them. The reason is Fast Refresh: saving the file that calls `component()`
  re-evaluates it, and React re-renders the old fibers with the new function
  while a fragment in another file still holds the old one. A per-call
  context differed between the two sides and the fragment threw "called
  outside" for a mount it was correctly nested in. `lib.ts` is never
  re-evaluated by an app-file save, so a context keyed there survives. With
  no stable identity to fall back on, an unnamed component would keep the
  defect, so `name` has no default: omitting it is a compile error and a
  `TypeError` at the call for untyped callers.
- **`component()` registers its mount with Fast Refresh when it can.** The
  refresh Babel plugin registers `const X = component(x, …)` only when the
  same file renders `<X />`. Babel plugin-react, webpack's refresh plugin
  and Next put `$RefreshReg$` on the global for the duration of a module's
  evaluation, which is when `component()` runs; `component()` calls it with
  the mount and the `name`. Where the global is a stub or scoped to the
  module (Vite+ and other rolldown-based plugins) the call is a no-op. Two
  calls with one `name` in one file share a refresh family: the second
  `render` wins after a refresh.
- **What a real `@vitejs/plugin-react` server does**, measured against a
  scratch app (2026-09-18). The plugin wraps a module as a self-accepting
  refresh boundary only when its Babel pass registered something in that
  module. A feature file holding nothing but `component()` registers nothing,
  so a save of it full-reloads the page: no throw, no state kept. A feature
  file that also holds a registered fragment becomes a boundary; on save the
  plugin's export registration swaps the exported component, and before
  this change a fragment in another file threw
  `Counter.useFeature() called outside <Counter>` on the same save. After it,
  the save is a Fast Refresh: the marker set on `window` survives, the
  `render` edit lands, the store keeps its state, and the fragment still
  dispatches into it. Vite+'s own dev server ships no React refresh plugin,
  so under it every save is a full reload and none of this applies.
- **The context value is the per-render snapshot object**, not the store plus a
  selector. The subtree re-renders with the root on every fold regardless — the
  root's `useSyncExternalStore` re-renders it, and its children with it — so a
  selector only pays under `memo`, of which there is none. The store's
  `subscribe`/`getSnapshot` pair is there if that changes; adding a selector
  later is non-breaking.
- **Outside a mount of its component it throws**, naming the component. A
  `undefined` default would push the failure to the first property read, one
  frame away from the cause.
- **Nearest mount wins** under nesting, as any context does.
- **View fragment ≠ child feature.** A fragment is part of its feature's
  `render`, split across files — Elm's `view` decomposed into helpers, minus the
  explicit model argument. A child feature is a `Feature` of its own — built with `create`, mounted
  with `component` — and talks through validated props and `on<Tag>`.
  Nothing prevents a child feature rendered under
  `<Seed>` from calling `Seed.useFeature()`; it is a smell, because that
  feature's inputs stop being visible in its props schema. Documented, not
  enforced — the enforcement would cost a runtime check on every hook call to
  catch a mistake the type of the feature's own `render` already discourages.
- **`Children.as<(x) => ReactNode>()` stays** as the explicit form: a fragment
  the parent supplies, reusable outside the feature, handed exactly what it
  needs. `useFeature` is for fragments that belong to the feature.

## The command model

A `Command` is a small ADT. The leaf is an `Effect`; everything Effect can
already express is left to Effect.

```ts
type Command<A, R> =
  | { _tag: "None" }
  | { _tag: "Effect"; effect: (dispatch: Dispatcher<A>) => Effect<unknown, never, R> }
  | { _tag: "Keyed"; key: string; command: Command<A, R> }
  | { _tag: "Batch"; commands: ReadonlyArray<Command<A, R>> }
  | { _tag: "Cancel"; target: Group };

// `Dispatcher`, not `Dispatch`: the latter is the React-facing dispatch handed
// to `render`, which returns void because it is called from an event handler.
type Dispatcher<A> = (action: A) => Effect<void>;
type Group = string;
```

**Groups are one flat namespace per mount.** A `Group` is a string name, not a
`{ tag, key }` pair. `keyed(name)` sets a command's whole address — outermost
wins, unchanged — and an unkeyed command books under its issuing action's tag,
so the booking address is always `key ?? tag`. `cancel(name)` interrupts that
one group. A key equal to some action's tag is not a collision to defend
against; it is deliberate sharing — one namespace means one meaning per name.
The semantic narrowing to document: bare-tag `cancel("Tag")` reaches only the
**unkeyed** fibers of that tag, because keyed work is addressed by its own name
only.

**Concurrency is userland.** Debounce, throttle, switch-to-latest, run-at-most-N
— all of them are Effect combinators the handler writes inside its own effect.
The runtime has no policy vocabulary, because Effect already has one and a
second one written as data can only be a worse copy.

**What the runtime does own** is the one thing a handler cannot do for itself:
naming a running fiber so that a _different_ action's handler can interrupt it.
That is `Keyed` + `Cancel`, and it is the whole supervisor.

**Take-latest is sugar, not a variant.** `Command.restart(name, command)` is
definitionally `Command.batch(Command.cancel(name), Command.keyed(name,
command))` — the 80% pattern written as one word, without the ordering mistake
hand-writing the pair invites. No new ADT variant, no interpreter branch, no
new `CommandSummary` member: devtools show the desugared batch honestly.

**A command may be lazy.** `[state, (next) => command]` hands the command the
state it sits beside — the _next_ state — so a handler that writes state inline
and needs that same state in the command keeps its implicit return:

```ts
// before: name it, then use it twice
SetMode: (payload, { state }) => {
  const next = { ...state, mode: payload.mode };
  return Task.start(next, "colors", createColors.run(next));
},
// after: the thunk is handed what `Task.start` returned beside it
SetMode: (payload, { state }) =>
  Task.start({ ...state, mode: payload.mode }, "colors", createColors.run),
```

Resolved once, by `Next.command` — the accessor every consumer already reads
through (`reduce`'s `Unmounted` branch, `run`, the store's fold, teardown) — so
there is no second interpretation site to keep in step. It is not a `Command`
variant: the interpreter and devtools only ever see the command it returned.
`Task.start` accepts the thunk on the same terms and hands it the state with
`Pending` already written.

`LazyCommand`'s parameter is **bivariant** (a method type, the React event
handler trick). A handler's tuple state is routinely narrower than `State` —
spreading a value into an optional field makes it required — and under
`strictFunctionTypes` `(next: Narrow) => …` would not fit `Next<State>`; the
first frontend handler converted failed exactly so. The thunk only ever
receives the tuple's own state, which is that narrow value, so the loosening
is sound by construction.

`Batch` sequences commands. After the leaf change its one irreplaceable job is
putting a `Cancel` before the command that replaces it — the cancel has to run
before the new fiber is registered, and nothing inside that fiber can do it.
Composing two _effects_ is `Effect.all`, not `Batch`.

```ts
// restart-on-keystroke — take-latest as one word
TextEdited: (action, { state }) => [
  { ...state, text: action.text, pending: true },
  Command.restart(
    "query",
    Command.effect((dispatch) =>
      Effect.sleep("300 millis").pipe(
        Effect.andThen(search(action.text)),
        Effect.flatMap((hits) => dispatch({ _tag: "HitsArrived", hits })),
      ),
    ),
  ),
  // ≡ Command.batch(Command.cancel("query"), Command.keyed("query", …))
];

// two effects, one fiber
Added: (action, { state }) => [
  next,
  Command.effect(() => Effect.all([persist(next), track(action)])),
];

// a long-lived source: not a command — `subscriptions.specs.md` gives it its
// own hook on `create`, keyed and diffed by the runtime
subscriptions: ({ props }) => ({
  [`presence:${props.roomId}`]: Subscription.effect((dispatch) =>
    Stream.runForEach(presenceEvents(props.roomId), (event) => dispatch(toAction(event))),
  ),
});
```

## `snapshot.draft`, the mutable half of a handler

A reducer handler receives a `ReducerSnapshot`: the read-only `state`,
`props` and `hooks`, plus `draft`, a mutable view of `state` (`Draft<State>`).
The handler writes into the draft and returns it, alone or beside a command,
and the fold replaces it with the finished value before anything else reads
the `Next`. The handler contract does not change: it still returns
`Next<State>`, and a draft is a `State`. There is no `void` return and no
"return the command only" form — `return draft` is what says a handler
mutated.

**Lazy.** `draft` is a getter on the prototype of the one snapshot class
(`FoldSnapshot`). A handler that never reads it costs nothing: no proxy, no
finalize. Measured: a getter on an object literal costs V8 a fresh shape per
fold, about 140 ns, twenty times the fold; on a prototype it is a property
lookup, about 7 ns.

**Finishing rules**, applied by `reduce` for every consumer:

- Returned the draft, wrote into it: the finished value takes its place.
  Untouched siblings are shared by reference; the result is deep-frozen.
- Returned the draft, wrote nothing: the finished value is `state` itself,
  by reference, so the store's `moved` check is false and nothing is
  notified. That is the no-op.
- Returned another state, wrote nothing into the draft: the returned state
  wins and the draft is discarded. Reading the draft is free.
- Returned another state, wrote into the draft: a `TypeError`, on the same
  path as any handler that throws. Two next states and no rule that picks
  one.
- The handler threw: the draft is closed and unbooked, then the error
  propagates. Nothing decides a next state.
- A `LazyCommand` in the tuple runs at `Next.command`, after the fold
  replaced the draft, so it sees the finished state.

**Revocation.** The drafter revokes every proxy at finish. A copy that holds
draft children (`{ ...draft }`) is unreadable once the fold ends, which is
why `Task.start` given a draft writes `Pending` into it and returns the
draft, never a spread. It tells a draft from a state through a module-level
`WeakSet` of open drafts (`isLiveDraft`), filled by the getter and emptied
at close: a proxy cannot be branded without recording a write. `Next.lazy`
returns its tuple untouched and needs no such branch.

**Where the drafter comes from.** `Drafter` is a `Context.Reference` on the
terms `Devtools` set: total to read, `mutativeDrafter` (Mutative with
`enableAutoFreeze`) by default, replaceable at the root with
`drafterLayer(custom)`. A `DrafterService` is one method, `create(base)`,
returning `{ draft, finish }`. `mutative` is a dependency of the library.
Immer is not shipped; a user who wants it writes
`{ create: (base) => { const draft = createDraft(base); return { draft, finish: () => finishDraft(draft) }; } }`.

- `feature.reduce(action, snapshot, drafter?)` takes it as an optional
  third argument, `mutativeDrafter` when absent, so existing hand-driven
  tests are untouched.
- `run` reads it from `options.layer` (`Effect.service(Drafter)`, total).
- The store reads it from `runtime.cachedContext` once the context exists
  and caches it, on the sink's rule. Until the context exists — an async
  root layer still building — the default drafts.

**What is not drafted.** `render` and `subscriptions` receive a plain
`Snapshot`: neither is a place to change state. `Task.into`'s generated
handlers spread `snapshot.state` and are unaffected; `resolvedInto` and
`rejectedInto` write into `snapshot.draft` and hand it on. Effect data types
inside state (`Option`, `Chunk`, anything with `pipe`) are atomic to the
drafter and to `Draft<T>`: same value, same type, still immutable.

**Rejected shapes**, recorded under Deferred decisions: a `mutate(handler)`
wrapper, and `Drafter` as a required service with `mutative` an optional
peer.

## `snapshot.tasks`, the slot tasks' handles

`define({ tasks: { save: saveNote } })` binds a `Task` operation to a state
field under its key; `task.specs.md` holds the slot's semantics and its
clash rules. What it changes here:

- **`define`.** `State` is `StateOf<StateSchema> & TaskFields<TS>`
  (simplified; the schema's own type when the slot is empty), and the action
  union gains `TaskActionsOf<TS>`. The runtime extends the state schema with
  each `op.schema`, checks the slot, and builds a settle map from each
  operation's two tags to its key.
- **`FeatureDefinition` / `Reducer` / `LifecycleHandlers`** take a trailing
  `TS = {}`. The task tags are optional reducer keys; `Exhaustive` allows
  them because they are in `A`. `initialState` returns
  `InitialStateOf<State, TS>`, the state without the task keys, and the
  runtime spreads it over one `Task.idle` per key.
- **`reduce`.** For a settle tag, the field is written through a draft of
  its own (the same drafter, so the result is frozen), then the handler, if
  there is one, folds over that state on the finishing rules above; with no
  handler the written state is the result. `handles(tag)` is true for a
  settle tag either way.
- **`ReducerSnapshot<Props, State, H, TS = {}>`** gains
  `tasks: TaskHandles<TS, State>`. `tasks` is a second prototype getter on
  `FoldSnapshot`, built on first read and cached for the fold, so the own
  keys stay `state`, `props`, `hooks`. Each handle writes through `draft`,
  so what it writes and what the handler writes finish as one state. A
  feature with no slot hands a frozen `{}`.

`render` and `subscriptions` get no handles, for the reason they get no
draft. `subscriptions` also stays on `create` rather than moving to `define`
beside `tasks`: it is a function of the snapshot, while the task binding is
a static declaration the state, reducer and snapshot types are all read
from.

## Acceptance Criteria

`[x]` holds today. The command-leaf pass landed, and what it did not do is in
Open work and Deferred decisions rather than left as an unchecked criterion
here. The devtools pass closed the last two (its criteria live in
`devtools.specs.md`), and the flat-group-namespace + `Command.restart` pass
landed with every box checked again.

### Vocabularies (`Action`, `Action.output`, the `define` slots)

- [x] `Action("Tag", fields)` / `Action.output("Tag", fields)` constructs a `Schema.TaggedStruct` branded with its channel (`"internal"` vs `"outbound"`).
- [x] `fields` is optional: `Action("Reverted")` is `Action("Reverted", {})`. A message whose fields are all optional has `make()` with no argument, equal to `make({})`; a message with a required field does not.
- [x] `Action({ Tag: fields, … })` / `Action.output({ … })` is the record form: one branded message per key, the key as its tag, frozen, in key order. A lower-case key or a lifecycle key is a compile error naming the key.
- [x] `define`'s `actions` and `outputs` slots take a `MemberSource`: a message, a record of messages, a `Task` operation, or an array of those, one array deep inside another at most. There is no vocabulary wrapper; `define` flattens the source once, and `MemberOf`/`TagsOf` flatten it at the type level.
- [x] The slot is the channel check: `actions` takes internal members only and `outputs` outbound ones, so an outbound message, a `Task.output` operation or a mixed array in `actions` is a compile error, and the reverse in `outputs`. `define` repeats the check at runtime and throws a `TypeError` naming the tag, for a source that got past the types through a cast.
- [x] A tag declared twice across both slots throws a `TypeError` at `define`. The types do not catch it: two members with one tag unify into a union payload.
- [x] A `Task` operation is a member source through a module-private `members` brand, which survives the `{ ...operation, into }` spread; `op.actions` is the same pair, for reading.
- [x] The channels are not mutually assignable in either direction.
- [x] A reserved `LifecycleTag` (`Mounted`/`PropsChanged`/`Error`/`Unmounted`/`HookChanged`) as a message tag is a compile error.

### `Command`

- [x] `Command.none` is the `{ _tag: "None" }` no-op.
- [x] `Command.effect((dispatch) => Effect<unknown, never, R>)` is the only leaf. A command that emits nothing ignores the parameter.
- [x] `Command.effect(source, (dispatch) => …)` is the same leaf for a command written outside a handler: `source` is any `MemberSource` (a message, record, `Task` or array, either channel) and types `dispatch` as `Dispatcher<MembersOf<source>>`; `R` is inferred from the effect. The source is not stored: the command is the one-argument form's value.
- [x] `Command.stream` and the `Stream` variant are removed. A long-lived source is `Stream.runForEach(source, dispatch)` inside the effect, so the whole `Stream` vocabulary stays available one call earlier.
- [x] `Command.keyed(key, command)` names the group a command's fibers book under — the whole address, outermost wins. Also curried (`Command.keyed(key)`) and so pipeable. An unkeyed command books under its issuing action's tag.
- [x] `Command.ignore`, `Command.queue`, the `Policy` type and the `Guarded` node are removed.
- [x] `Command.restart(name, command)` returns — as pure sugar, not a policy: it constructs exactly `Command.batch(Command.cancel(name), Command.keyed(name, command))`. Also curried (`Command.restart(name)`) and so pipeable.
- [x] `Command.batch(...commands)` interprets its members in order under one context. With no policy there is no supersession question and nothing to decide.
- [x] `Command.cancel(name)` interrupts the one group booked under `name`, whatever action tags forked its members. The fiber book is a flat map by name — no tag level, no delimiter encoding.
- [x] Bare-tag `cancel("Tag")` reaches only the **unkeyed** fibers of that tag; work forked under `keyed(name)` is addressed by `name` alone.
- [x] Cancelling work started from several action tags under one `keyed(name)` is one line — `cancel(name)` — naming no foreign tag.
- [x] Every `dispatch` — `render`'s, `useFeature().dispatch`, and the `Dispatcher` a `Command.effect` or `Subscription.effect` leaf is handed — takes a built message or a message schema and its payload: `dispatch(Bump, { by: 2 })` is `dispatch(Bump.make({ by: 2 }))`, and the payload is omitted when every field is optional (`dispatch(Reverted)`). `make` validates, so a rejected payload is a defect of the command or subscription that sent it, and throws out of the event handler that called `render`'s dispatch.
- [x] `Command.output(message, payload)` emits an outbound message; passing an internal message is a compile error. _Re-expressed on the new leaf internally; signature unchanged. Removing it is deferred — see Deferred decisions._
- [x] Commands are `Pipeable`, and piping preserves `A` and `R`.

### `Next` accessors

- [x] `Next.state(next)` returns the state whether `next` is a bare state or a `[state, command]` tuple.
- [x] `Next.command(next)` returns the command for a tuple, `undefined` for a bare state.
- [x] `Next.command(next)` resolves a lazy command by calling it **once** with the tuple's own state, by identity, and returns what it returned. Every consumer — `reduce`'s `Unmounted` branch, `run`, the store's fold and teardown — reads through it, so a lazy command reaches the interpreter already resolved.
- [x] `Task.start(state, key, thunk)` accepts a lazy command and hands it the state with `Pending` written.
- [x] `Next.lazy(state, thunk)` returns the `[state, thunk]` tuple unchanged, by identity on both parts, with `State` inferred from `state`; it is a name for the lazy form, and `Next.command` resolves its result like any other tuple.

### `Feature.reduce`

- [x] Dispatches by `_tag` to the matching handler (declared or lifecycle) and returns its `Next`.
- [x] An unhandled _lifecycle_ action leaves state unchanged and does not throw.
- [x] A missing handler for anything that is not a lifecycle tag throws — reachable only by bypassing the typed surface.
- [x] Every tag-keyed lookup uses `Object.hasOwn`, so `constructor`/`toString` and the rest of `Object.prototype` cannot pose as handlers, lifecycle tags, or declared outputs.
- [x] `Unmounted`'s handler runs but its returned state is discarded — only its command matters. `reduce` and `run` agree on this.

### `snapshot.draft`

- [x] A handler that writes into `draft` and returns it gets the finished value in its place: the written path is new, untouched siblings are the same objects as in `state`, the base is unchanged, and the result is deep-frozen.
- [x] A handler that returns an untouched `draft` returns `state` itself, by reference.
- [x] A `[draft, command]` tuple is finished before `Next.command` resolves a lazy command, so the thunk receives the finished state, not the proxy.
- [x] A handler that spreads `state` beside a drafting handler behaves as before; its result is not frozen.
- [x] A handler that writes into `draft` and returns another state throws a `TypeError` naming `snapshot.draft`; under the store it is a defect from that action and state is kept, under `run` the Effect dies with it as for any throwing handler.
- [x] A handler that reads `draft` and returns another state keeps the returned state; the proxy is revoked once the fold ends.
- [x] A handler that throws with a draft open still closes it: the proxy is revoked and the handler's own error propagates.
- [x] `Task.start(draft, key, command)` writes `Pending` into the draft and returns the draft, so its result is the finished state; given a plain state it spreads as before.
- [x] The snapshot's own keys are `state`, `props`, `hooks`; `draft` is reachable and lives on the prototype; the drafter is not reachable.

### `snapshot.tasks` and the `tasks` slot

- [x] `define({ tasks })` adds one `TaskValue` field per key and fills it with `Task.idle` under the feature's initial state, which is spread on top.
- [x] `reduce` writes a settle tag's field before the handler runs, and with no handler returns the written state; a handler returning `snapshot.state` returns the field write alone.
- [x] `snapshot.tasks.<key>.start` / `.cancel()` write `Pending` / `Idle` into the draft and return `[draft, command]`; under `mode: "first"` a start while `Pending` returns `[snapshot.state, Command.none]`.
- [x] `snapshot.tasks` is on the prototype: the snapshot's own keys stay `state`, `props`, `hooks`, and a feature without a slot hands `{}`.
- [x] `define` throws a `TypeError` for each clash rule in `task.specs.md`.
- [x] `reduce` drafts with its optional third argument, `run` with the `Drafter` in `options.layer`, the store with the `Drafter` in the root runtime; each defaults to `mutativeDrafter`.

### `Feature.run`

- [x] Seeded actions are processed but are not recorded in `emitted`.
- [x] After each action is reduced and its command interpreted, the loop yields once, so the fibers that action forked run to their first suspension before the next action is reduced. A `restart` issued by the second of two seeded actions therefore interrupts a request the first already sent.
- [x] Actions a command emits feed back into the reducer loop; `emitted` collects them.
- [x] `outputs` collects messages whose tag is a declared output; an output never re-enters the reducer.
- [x] A handler receives the action's **payload** — `_tag` stripped on the same terms as an output crossing into its `on<Tag>` prop: the handler key already named the tag, so what the handler holds cannot smuggle a tag into state or a command's payload. Lifecycle handlers receive theirs on the same rule.
- [x] `Command.cancel(name)` interrupts the group booked under `name`; an unkeyed command's group is its issuing action's tag.
- [x] `Command.batch` members run in order, sharing the issuing action's context.
- [x] Services a command requests (`R`) are satisfied from `options.layer`.
- [x] `run` resolves only at quiescence: nothing queued, nothing in flight — including fibers that settle without emitting.
- [x] **`run` does not terminate on a never-completing command**, and its test asserts that deliberately. Since the split in `subscriptions.specs.md` this is the definition of a command — work that finishes — and a never-completing effect belongs in a subscription, which `run` does not wait for. That spec inverted the test's subject and keeps this form as the control.
- [x] A command that dies is recorded in `defects` — `{ from, error, handled }`, in the order observed — and `run` stays total: a defect never fails the returned Effect. Interruption is not a defect.
- [x] When the feature has an `Error` handler, a dying command folds `Error` through it before `run` resolves, on the store's rule: a death inside the `Error` handler's own command is recorded with `handled: false` and not re-folded. The `Error` action is the runtime's own and is not `emitted`.

### React binding (`createRuntime` → `component`)

- [x] `Feature` carries its internals behind a module-private `unique symbol`; `reduce` and `run` remain the entire public surface.
- [x] `component(feature)` renders `render({ state, props, hooks, dispatch })` and re-renders when a command changes state.
- [x] Incoming props are split by derived name (`outputTags.map(t => "on" + t)`), so a declared prop merely starting with `on` is left alone.
- [x] `validateProps` runs the schema with `onExcessProperty: "error"` and **throws** — a malformed prop is the parent's defect and belongs at the error boundary. It runs on mount and on props-identity change, not on a state-driven re-render.
- [x] A feature rendered with a `key` validates in React's development build. React defines a non-enumerable `key` warning getter on a keyed element's props (and a `ref` one on 18); `splitOutputProps` copies such an object through `Object.keys`, which skips them, so the decoder's own-property read never sees them. A props object without either getter still passes through by identity. (`lib.stress.browser.test.tsx`)
- [x] An output leaves through its `on<Tag>` prop with `_tag` stripped and never re-enters the reducer; a missing handler throws to the boundary rather than into this feature's `Error` handler.
- [x] `Children` is a props field that validates any value, so a feature can declare `children` and still be validated with `onExcessProperty: "error"`. Declared plainly it is required — the key is absent, not `undefined`, when JSX passes no children — and `Schema.optionalKey(Children)` is the optional form.
- [x] `Children.as<T>()` is the same declaration at any children type — a render prop, one element, a tuple of slots. It is opaque on identical terms, and the type argument is the only thing holding the caller to the contract.
- [x] `Children` carries a constantly-`true` equivalence, so a new node alone never raises `PropsChanged` and never re-runs the reducer. The corollary — a reducer's `snapshot.props.children` may be stale — is accepted, and `render` is unaffected.
- [x] The props carrying the `"@wych/opaque"` annotation are collected off the props schema at `create`, whether the key is declared directly, through `Schema.optionalKey`, or through `Schema.optional` (a union). A feature declaring none collects `[]`.
- [x] `PropsChanged`'s reported `previous` has each opaque prop replaced by its placeholder (`"<children>"`), which is what keeps every devtools event JSON round-trippable. The reducer's snapshot keeps the real node; a feature with no opaque props reports the action unchanged.
- [x] `dispatch` accepts declared actions **and declared outputs** — the store routes every dispatched message by tag, so an output dispatched from the view leaves through its `on<Tag>` prop without touching the reducer — and is reference-stable for the life of the mount. An undeclared tag stays a compile error.
- [x] Lifecycle order: `Mounted` once per mount, then `PropsChanged`/`HookChanged` as ambient inputs change, then `Unmounted` at teardown. Before the first `start`, `sync` records and raises nothing, so `Mounted` is the first lifecycle action folded and its snapshot carries the props and hooks in force at mount (`lib.test.ts` "before the first start, records without raising"); a props change landing in the very first commit folds after `Mounted`, its command after `Mounted`'s (`lib.browser.test.tsx` "`Mounted` folds before a `PropsChanged` that lands in the first commit").
- [x] `PropsChanged`/`HookChanged` are detected **by value** — props via `Schema.toEquivalence`, hooks via `Equivalence.Record(Equivalence.strictEqual())`.
- [x] `store.sync` is called from a `useLayoutEffect` with no dependency list, once per committed render; the render body reads and writes nothing in the store, so a render React abandons never folds, never advances the baseline and never starts a subscription. A props-driven change costs two renders and one paint: the fold's synchronous re-render is flushed in the same commit, before the browser paints (`lib.browser.test.tsx` "a props change costs two renders and one frame, measured"). See Deferred decisions.
- [x] `store.sync` is idempotent: called twice with equivalent props and hooks it raises nothing the second time, so StrictMode's second layout effect costs nothing.
- [x] `useUnsafeHooks` is called with the state the render reads. A props-driven fold re-renders synchronously, the hook re-evaluates against the new state, and the next layout effect raises `HookChanged` if its value moved, so a hook derived from state lands in the same flush (`lib.browser.test.tsx` "a hook derived from state catches up").
- [x] `renderToString` renders a feature server-side: `initialState(props)` paints, `validateProps` still throws on bad props, `useFeature` fragments resolve their provider, and **nothing folds** — no `Mounted`, no commands, no store arming, because the arming lives in an effect and effects do not run on the server. `useSyncExternalStore` is passed its server snapshot, without which React throws under `renderToString`.
- [x] A defect from a command, a handler that throws, or a feature `layer` that fails to build reaches the `Error` handler, with `cause` always `Cause.die(error)` and `from` naming the origin — the tag of the action whose command died or whose handler threw, `"Mounted"` for a layer that failed to build, `"Unmounted"` for a teardown that threw or overran; with none declared it is rethrown during render, the only place a boundary can catch it.
- [x] **A mount whose fiber died re-arms on demand.** After a layer failure the store is `dead`, not stopped: the next command a **dispatch** produces calls `start` again, which rebuilds the layer and hands the command to the new mount. Work caused by a lifecycle action or by a command never re-arms, so `Mounted`'s own command on the rebuilt mount cannot re-enter `start`, and a permanently failing layer rebuilds exactly once per dispatch — each failure reaching the `Error` handler again — rather than spinning. `stop` on a dead mount still folds and reports `Unmounted` (its command reported `dropped: true`, there being no scope to run it in) and clears `dead`, so a dispatch after unmount drops as it always did.
- [x] Services come from the root `ManagedRuntime`; `component(bp, { layer })` satisfies the residue `Exclude<R, RootR>`.
- [x] `createRuntime` takes **one** parameter. `RuntimeOptions` and its unwired `onEvent` are removed; observation is a service installed through the root layer instead. Spec'd in `devtools.specs.md`.
- [x] The store reports transitions, commands issued, outputs emitted and defects to a synchronously-resolved `Devtools` sink, and allocates nothing at those sites when no sink is installed. Emission points are listed in `devtools.specs.md`.

### Feature context (`component(bp).useFeature`)

- [x] `component(bp, options)` returns `FeatureComponent<Props, State, Action, Output, H>` — `FC<Simplify<Props & OutputProps<Output>>> & { readonly useFeature: () => RenderSnapshot<Props, State, Action | Output, H> }`. The intersection adds a member and removes none.
- [x] `options.name` is required on both overloads: `component(bp)`, `component(bp, {})` and `component(bp, { layer })` are compile errors, and a call that reaches the runtime without a string name throws `TypeError` naming the fix.
- [x] `useFeature()` returns the `RenderSnapshot` of the nearest enclosing mount of **a component with that `name`**: `state`, `props`, `hooks`, `dispatch` — the same object `render` received on the same render, by identity.
- [x] `dispatch` obtained through `useFeature` is the store's own: reference-stable for the mount, routes a declared output to its `on<Tag>` prop without touching the reducer, and reports `cause: { _tag: "Dispatch" }` — a fragment's dispatch is indistinguishable from `render`'s.
- [x] After a fold moves state, a fragment reading `state` re-renders and sees the new state on the same render as the root — never one render behind.
- [x] Two `component()` calls with different names are independent: `A.useFeature()` under `<B>` throws, even when both wrap the same feature. Two calls with one name share the scope: a fragment made against the first resolves a mount of the second.
- [x] Nested mounts of one name: a fragment resolves the nearest.
- [x] Called outside any mount of its name, throws `TypeError` with message `` `${name}.useFeature() called outside <${name}>` ``.
- [x] Re-evaluating the module that calls `component()` — Fast Refresh's save — yields a component whose `useFeature` context is the first call's. Under a refresh, a fragment in another file that still holds the first component keeps reading the mount that now runs the second, the store and its state survive, and the `render` edit lands; a fragment in the same file swapped while an unregistered mount keeps running keeps reading the store too. Pinned by `hmr.browser.test.tsx` against the real `react-refresh` runtime.
- [x] When `$RefreshReg$` is a function on the global during `component()`, the mount is registered under the `name`, so a bundler that exposes the hook swaps it on refresh and the `render` edit lands even where the Babel plugin registered nothing. Absent the hook, nothing is called.
- [x] A node the parent passes as `children` and the feature renders inside its tree may call `useFeature()` — the provider is positional, so this is React's compound-component shape (`<Select><SelectItem/></Select>`) and works by construction. Not a target, not prevented.
- [x] `validateProps`, `sync`, `start`/`stop`, StrictMode behaviour and every devtools emission are untouched. The provider is one element around `render`'s output.
- [x] `FeatureComponent` is exported, so a fragment can type a prop as `typeof Seed` or the snapshot as `ReturnType<typeof Seed.useFeature>` without reconstructing the generics.

### Type-level (TSTyche)

- [x] `Disjoint`, `NoPropCollision`, `Exhaustive`/`Excess`, `ServiceOf`/`ServicesOf` reject what they document and accept what they document.
- [x] `MemberOf` over `[Started, [Action({ Failed }), load]]` is the union of the four message values, `TagsOf` their tags; each slot rejects a member of the other channel, alone, in an array, or as a `Task`. `MemberSource`'s depth is bounded because `MemberOf` recurses over it, and over a recursive constraint it never bottoms out (`Type instantiation is excessively deep`).
- [x] A transforming props schema is accepted: `define` normalizes it to its `Type` side with `Schema.toType`, so a codec field surfaces to `initialState`, the reducer and `render` as its decoded `Type`, the parent passes decoded values, and the wire shape is rejected by `validateProps` rather than decoded.
- [x] A props schema declaring `children: Children` surfaces the field to `initialState`, the reducer and `render` as `ReactNode`, optional under `Schema.optionalKey` and as the given function type under `Children.as<T>()`.
- [x] `Command<Narrow>` stays assignable to `Command<Wide>` under the callback leaf, and `Command.none: Command<never>` stays the bottom. `Dispatcher<A>` is contravariant in `A` and sits in a parameter position — contravariant again — so the two compose to covariant. **The existing covariance test passes unchanged.**
- [x] `Command.effect` carries `R` out of the effect it is handed. `A` has no inference site of its own, so it defaults to `never`: a command that emits nothing is `Command<never, R>` and fits every slot. Passing a bare `Effect` — the pre-redesign shape — no longer compiles, and neither does an effect with an open error channel.
- [x] Inside a handler, `dispatch` is typed by the feature's own vocabulary: `A` arrives from the contextual type of the handler's return. An undeclared tag and a declared tag with the wrong payload are both compile errors.
- [x] `Dispatcher<A>` and `Dispatch<A>` are two overloads: `<M extends MessageOf<A>>(message: M, ...payload: PayloadArgs<M>)`, then `(action: A)`. A schema whose `Type` is not in `A`, a missing required payload and a wrong payload are compile errors; `MessageOf<never>` admits nothing, so a standalone leaf still accepts nothing. The value form is last, so `Stream.runForEach(stream, dispatch)` infers it. The covariance of `Command` in `A` is unchanged. A lambda written against `Dispatcher` by hand needs its parameter annotated: an overloaded target gives no contextual parameter type.
- [x] `Command.keyed` preserves `A` and `R`, through `.pipe`, applied directly, and nested. The key is a required string.
- [x] `Command.batch` preserves `A` and `R`, and a `Command<never>` member — the `Cancel` the variant exists to sequence — does not collapse the batch to `never`.
- [x] `Command.cancel` is `Command<never>` and takes exactly one string. An object target — `{ tag }` or `{ tag, key }` — is a compile error, as are a number and a zero-argument call.
- [x] `ignore`/`queue`/`stream` are absent from the constructor set, and the `Stream` and `Guarded` variants are absent from the ADT.
- [x] `restart` is a constructor-set member, not an ADT variant, and preserves `A` and `R` in both forms. The two-argument form keeps contextual `A` (the same rule as `keyed`); the `.pipe` form severs it, pinned with `@ts-expect-error` on identical terms.
- [x] A lazy command's parameter is typed as the feature's `State`, and its `dispatch` keeps the contextual `A`: an undeclared tag is a compile error one function deeper, on the same terms as the leaf.
- [x] `ServicesOf` reads `R` through a lazy command, so a service the thunk's command needs is still a compile error at `component`.
- [x] A lazy command whose tuple state is narrower than `State` (an optional field written as required) still satisfies the handler's return type. In a raw tuple its parameter is contextually typed as `State`; through `Task.start`, which infers from its first argument, it is the narrower state actually written.
- [x] `Seed.useFeature()` is typed `RenderSnapshot<Props, State, Action | Output, H>`: `state` is the state schema's `Type`, `props` the props schema's `Type` side (decoded, `children` as declared), `hooks` is `H`, and `dispatch` accepts every declared action and output and rejects an undeclared tag and a declared tag with the wrong payload.
- [x] `useFeature` is present on **both** `component` overloads — with and without `layer` — and on a feature with no outputs (`Output` = `never`) `dispatch` accepts the actions alone.
- [x] `Seed` remains assignable to `FC<…>` where an `FC` is expected: the added member does not change what JSX accepts.
- [x] `snapshot.draft` is `Draft<State>`: arrays and plain objects lose `readonly` recursively, an Effect data type keeps its type, `state` and `props` beside it stay read-only, and a wrong shape written into the draft is the error a wrong shape in a spread is. A draft satisfies `Next` bare and in a tuple.
- [x] `Task.start` and `Next.lazy` accept a draft; `Task.start`'s key is still constrained to the task fields; the lazy thunk's parameter is the draft's type. `Exhaustive` reports no excess for a drafting handler.
- [x] A command returned beside a draft still carries `R` to `component`.
- [x] `render` and `subscriptions` snapshots have no `draft`.
- [x] `ReducerSnapshot`'s `tasks` is `TaskHandles<TS, State>`, `{}` without a slot; the `tasks` slot's types (merged `State`, `initialState` without the task keys, optional settle keys, `start`'s input and `R`, the clash guards) are pinned in `task.tst.ts`.
- [x] `reduce` accepts an optional `DrafterService`; `drafterLayer(…)` is `Layer.Layer<never>`.

**How `A` reaches the leaf.** `A` appears only inside `Dispatcher<A>`, in a
parameter position, so nothing in the argument can infer it — it is resolved from
the contextual type of the call, which the reducer's return type supplies through
`create`'s `U extends Reducer<…>` constraint. Written standalone, with no
contextual type, `A` falls back to `never` and `dispatch` accepts nothing; the
call site names the messages it may emit as a value, `Command.effect(Loaded,
(dispatch) => …)`, which also leaves `R` to inference. A type argument names
them too (`Command.effect<Action, R>(…)`), but TypeScript has no partial
inference, so naming `A` that way forces `R` to be spelled as well. The spec's
examples rely on the contextual path, and a type test compiles each of them to
say so.

Two consequences the surface had to absorb, both found by compiling the example
above rather than by reasoning about it:

- **`Command.cancel` is generic in `A`, defaulting to `never`.** A concrete
  `Command<never>` argument is an inference source at higher priority than the
  contextual return type, so a cancel written _first_ in a batch — the position
  `restart` desugars into — fixed the batch's `A` to `never` before the sibling
  leaf was checked, and `dispatch` accepted nothing. Generic-with-a-default, the
  cancel adopts the batch's `A` instead of pinning it, and standalone — the
  cross-tag one-liner — it is still `Command<never>`.
- **`Command.keyed` takes `(key, command)` as well as `(key)`.** A `.pipe`
  receiver is checked before `.pipe`'s own contextual type exists, so
  `Command.effect((dispatch) => …).pipe(Command.keyed("q"))` severs the
  contextual path no matter what — a TypeScript rule about receivers, not
  something this surface can fix. The two-argument form puts the leaf in an
  argument position, where the contextual type reaches it. Piping still
  type-preserves and is still the right form for a command whose `A` is already
  fixed; it just cannot _carry_ inference.

Consequence for the tests: `expect(fn).type.toBeCallableWith(arg)` types `arg` on
its own, without the contextual type of the signature under test, so every
context-sensitive callback inside one collapses to `never`. Assertions about
contextual inference are therefore written as direct calls plus
`@ts-expect-error`, not as that matcher — otherwise they measure the matcher.

### Browser coverage (`/e2e`)

`src/lib.browser.test.tsx` covers the React binding: that a feature paints,
that a real click repaints, that an output crosses into a parent's `on<Tag>`
prop. Nothing in the leaf change alters any of that, and it still passes
unchanged — which is the point of running it.

It also covers both halves of `Children` together, which only a browser can
show: a parent passes a node that changes on every tick, the node reaches the
DOM and stays current, and the reducer's `PropsChanged` never fires. A second
test mounts a render prop — children the feature _calls_, with state only it
has — and repaints it from a dispatch.

`useFeature` is a React-binding change, so its coverage is browser-only — there
is no node seam for a context, and `component` is not unit-tested in node
today. Four tests, each pinning one criterion the node suite cannot:

- A fragment two levels below `render` reads `state` and dispatches from a real
  click; the root and the fragment repaint together, and the fragment's DOM
  shows the post-fold state on the same paint as the root's.
- A fragment dispatches a declared **output**; it reaches the parent's
  `on<Tag>` prop with `_tag` stripped, and the reducer never sees it.
- A fragment rendered outside any `<Seed>` throws, and the message reaching a
  boundary names the component.
- Two mounts of one component each carry a fragment; each fragment reads its
  own mount's state and a dispatch in one leaves the other untouched.

`src/hmr.browser.test.tsx` drives the real `react-refresh` runtime, hooked in
by `src/__fixtures__/react-refresh.ts` before `react-dom` loads. A function
stands for one evaluation of a file, `RefreshRuntime.register` for the Babel
plugin's registration, a `$RefreshReg$` global for a Babel-based bundler's
hook, and `performReactRefresh` for what Vite calls after the module re-ran.
It pins the two shapes that used to throw (fragment in another file; same-file
fragment beside an unregistered mount), the `$RefreshReg$` registration, the
name-scope rules, and a control where both sides are registered. One limit
it records rather than fixes: a reducer edit still needs a remount, because
the store keeps the `feature` it was created with.

The debounce story — four keystrokes inside one window send exactly one
query, first through the old `"restart"` policy, then a hand-written `Cancel`
ahead of a `keyed` leaf, now `Command.restart` as sugar for that pair — is
covered by the `restart` cases in `lib.test.ts` and by the docs snippets for
`how-to/debounce-and-take-latest.md`, which `docs:check --run` executes in a
real browser. The runnable version is `docs/examples/search-debounce`.

- e2e: the in-repo examples that used to live under `src/examples`
  (`cart.tsx`, `presence.tsx`, `app.tsx`) are gone. Their successors are the
  self-contained projects under `docs/examples/*` (`cart-tests`,
  `presence-stream`, `devtools-console`, …), each type-checked by
  `vpr -r test:types`; `cart-tests` runs its `feature.run` assertions under
  `vpr -r test`. The docs pages that build them are executed by
  `docs:check --run`.

## Technical Requirements

- Effect 4 beta, one pinned version. `mutative` as the one runtime
  dependency, behind `Drafter`'s default.
- The handler snapshot is one class, `FoldSnapshot`, built in `reduce`, with
  `draft` as a prototype getter and the drafter in a private field. Own
  keys stay `state`, `props`, `hooks`. `finish` reads the tuple shape
  before it closes the draft: `Array.isArray` on a revoked proxy throws.
- The fold is synchronous; only commands are Effects. A re-entrancy guard
  serialises folds — a command emitting on the forking stack would otherwise
  re-enter mid-write and have the outer fold write stale state on the way out.
- The store **object** (state cell, subscribers, pending queue) lives as long as
  the component instance; its **Effect scope** is opened by the mount effect and
  closed by that effect's cleanup. StrictMode forces the split: a store created
  in `useState` survives a simulated unmount, so a single `dispose()` would leave
  the remounted component holding a closed scope.
- The command queue and the fiber book (a flat map from group name to fibers,
  plus an in-flight counter — plain mutable fields, since every update is one
  synchronous step on one thread) are **per mount**, not per store, so a stale
  fiber can only take from a queue nobody offers to again.
- A command's emissions route back to the mount whose command emitted them, not
  to whichever mount is currently installed. Routing is carried per pending
  action (set only for command-emitted actions), so a fresh `dispatch` a
  parent's `on<Tag>` handler makes re-entrantly during a teardown drain still
  targets the live mount.
- Output handlers are read through a latest-ref assigned in a **layout
  effect**. A passive effect left a gap — a command fiber can emit on a
  microtask between the commit and the passive flush and see the previous
  render's handler — while a render-phase assignment had the opposite hole: a
  render pass React abandons would leave a never-committed handler in the ref
  (reproduced under suspension inside a transition). Commit and layout effects
  run in one synchronous task, which closes both.
- `Cancel` (and the teardown sweep) interrupt via `Fiber.interruptAll`: every
  fiber in the group is **signalled before any is awaited**, so a slow or hung
  finalizer on one member no longer delays — or blocks forever — the interrupt
  signal to its siblings, and no member can keep emitting during another's
  finalizer window. The teardown sweep covers subscription fibers only, per
  `subscriptions.specs.md`; command fibers finish.
- The mount loop runs inside `Effect.scoped`, so the mount's own scope is
  ambient to command fibers: a command's `Effect.addFinalizer` lands on it and
  runs when the mount closes, before the feature layer is released.
- Feature layers are built per mount and released with it. Anything that must
  survive a mount belongs in the root layer.
- Teardown runs in-band, on the fiber that owns the scope, with the feature's own
  services still alive — then the scope closes. Bounded as a whole; an abandoned
  teardown is reported as a defect rather than silently closing.
- `useFeature` is one `createContext<RenderSnapshot | undefined>(undefined)`
  **per `name`**, held in a module-level `Map<string, Context>` in `lib.ts`
  and fetched or created by `component()`, so its identity survives a
  re-evaluation of the calling module. The registry is module-level rather
  than per `createRuntime` because a save of the file calling `createRuntime`
  re-runs the feature files that import it and not the fragment files. It
  grows by one context per distinct name and is never freed. `Feature` builds
  the snapshot once and hands the same object to `render` and to the
  provider: `createElement(Snapshot.Provider, { value: snapshot }, render(snapshot))`.
  The hook is attached with `Object.assign(Feature, { useFeature })` after
  `displayName` and the `$RefreshReg$` call, and the throw uses the same
  `name`.

- The store and the `createRuntime` result carry a test-only probe behind the
  `internals` symbol: the store's returns its closure counters (`mounted`,
  `active`, `dead`, `queued`, `inFlight`, `groups`, `fibers`, `live`,
  `subscriptions`, `declared`, `buffered`, `pending`, `subscribers`), the
  runtime's the size of the `useFeature` context registry. Read by the bench
  and stress suites through the symbol's description, never exported by name,
  so the docs do not list it. Zero cost until read.

## Expected Behavior & Edge Cases

- `Mounted` fires once **per effect cycle** — twice in StrictMode dev. Latching
  it to once per store object was rejected: it hides non-idempotent `Mounted`
  handlers that will misbehave under Suspense and offscreen remounts.
- Interruption is how commands normally end (`Cancel`, unmount), so it is never
  reported as a defect. Only a genuine failure is.
- A command that dies is reported via the interpreter's exit hook. It forks and
  returns, so a dying child propagates to nobody — without the hook every runtime
  defect from a command vanishes silently.
- A command dropped after the component is gone is dropped **silently**. Reporting
  it was tried and reverted: `component`'s defect sink throws to the error
  boundary, so it replaced a feature's recovery UI with a crash on exactly the
  failure its `Error` handler existed to handle.
- Unmount interrupts subscription fibers, runs the `Unmounted` command with
  services alive, then drains: in-flight commands finish and what they emit
  folds, the whole under the 5s bound. Flush-on-exit is the default;
  kill-on-exit is `Command.cancel` from the `Unmounted` handler. Open work #2
  records the decision; `subscriptions.specs.md` owns the criteria.
- Teardown's `Unmounted` command is unkeyed, so it books under `"Unmounted"` in
  the flat namespace. A user group named `"Unmounted"` shares that entry with
  the teardown command and both drain to completion; the two only meet when
  the `Unmounted` handler itself returns `Command.cancel("Unmounted")`, which
  then interrupts the user's fibers as asked.
- **`useFeature` inside `render` itself is wrong, and under nesting it is
  silently wrong.** `render` is a plain call in `Feature`'s body, so a hook in
  it is `Feature`'s hook, and `useContext` there reads the provider _above_
  `Feature` — not the one `Feature` is about to mount. Outside nesting that
  throws; with an outer mount of the same name it returns the outer
  snapshot. `render` already has the snapshot as its argument; there is no
  reason to reach for the hook there, and a guard would cost every fragment's
  call to catch a mistake with no motive.
- The provider re-renders its consumers on every root render, since the
  snapshot is a fresh object each time. That is the same set of components the
  root's own re-render already re-renders; a `memo`'d fragment that reads the
  context loses the memo, which is the correct outcome for a component reading
  changing state.

## Performance and resilience

Two on-demand Vitest projects, outside `vpr -r test`. The `bench` project
(`src/**/*.bench.test.ts`) runs tinybench through Vitest bench mode; the `stress`
and `stress-browser` projects (`src/**/*.stress.test.ts`,
`src/**/*.stress.browser.test.tsx`) hold the load, chaos, leak and property
tests. Fixtures are in `src/__fixtures__/`: `probe.ts` (the internals
probes, browser-safe), `devtools.ts` (recorder queries), `dom.tsx` (the
browser harness) and `stress.ts` (node-only helpers, re-exporting `probe.ts`).

### How to run

From `packages/react`:

    vp run bench:baseline    # write bench/baseline.json (local, gitignored)
    vp run bench             # against it, informational ratio column
    vp run stress            # node then browser
    vp run stress:node       # STRESS_SCALE=4 for a headroom run
    vp run stress:browser

### Baseline

`bench/baseline.json` is not committed. Absolute tinybench numbers only
compare against the machine that wrote them, and hosted CI runners are
noisier than a laptop, so the workflow is: `bench:baseline` before a change,
`bench` after, same machine, same session. What is stable across hardware is
the intra-run ratios in the summary (sink overhead against the no-sink
control, `batch 100` against `batch 10`, `diff on` against `diff off`); read
those when comparing runs from different machines.

The table below records magnitudes on one named machine, as documentation.
Written 2026-09-19 on an AMD Ryzen 7 5700X3D, Node v24.21.0,
`effect@4.0.0-rc.112`, React 19.2.8, headless Chromium. Indicative only:
tinybench varies 10 to 20 percent between runs and the compare column is a
prompt to look, not a gate. Async benches include an `await` on the probe
between iterations.

| file                     | group            | bench                                                     | mean      |
| ------------------------ | ---------------- | --------------------------------------------------------- | --------- |
| `devtools.bench.test.ts` | fold with a sink | dispatch: counting sink                                   | 0.23 µs   |
| `devtools.bench.test.ts` | fold with a sink | dispatch: console sink, diff off                          | 0.95 µs   |
| `devtools.bench.test.ts` | fold with a sink | dispatch: console sink, diff on                           | 1.03 µs   |
| `devtools.bench.test.ts` | fold with a sink | dispatch: no sink (control)                               | 0.21 µs   |
| `lib.bench.test.ts`      | fold             | dispatch: no sink, no hook                                | 0.22 µs   |
| `lib.bench.test.ts`      | commands         | Command.effect: fork one leaf and settle                  | 21.02 µs  |
| `lib.bench.test.ts`      | commands         | Command.batch: 1 leaves and settle                        | 20.88 µs  |
| `lib.bench.test.ts`      | commands         | Command.batch: 10 leaves and settle                       | 84.19 µs  |
| `lib.bench.test.ts`      | commands         | Command.batch: 100 leaves and settle                      | 731.88 µs |
| `lib.bench.test.ts`      | commands         | Command.restart: 100 dispatches into one key, then cancel | 1.4 ms    |
| `lib.bench.test.ts`      | Feature.run      | 10k seeds, no commands                                    | 25.2 ms   |
| `lib.bench.test.ts`      | Feature.run      | 10k seeds, each emits one action                          | 135.9 ms  |
| `lib.bench.test.ts`      | props            | Schema.toEquivalence: 3 fields, equal by value            | 0.17 µs   |
| `lib.bench.test.ts`      | props            | decodeUnknownSync: 3 fields                               | 0.67 µs   |
| `lib.bench.test.ts`      | props            | Schema.toEquivalence: 30 fields, equal by value           | 1.78 µs   |
| `lib.bench.test.ts`      | props            | decodeUnknownSync: 30 fields                              | 3.24 µs   |
| `lib.bench.test.ts`      | props            | Schema.toEquivalence: 300 fields, equal by value          | 26.11 µs  |
| `lib.bench.test.ts`      | props            | decodeUnknownSync: 300 fields                             | 53.07 µs  |
| `lib.bench.test.ts`      | props            | store.sync: 30 fields, equal props                        | 1.93 µs   |
| `lib.bench.test.ts`      | props            | store.sync: 30 fields, one field changed                  | 0.60 µs   |

The `draft` group was added 2026-09-20 on an Apple M5, Node v24.21.0,
`effect@4.0.0-rc.116`, so its rows are on a different machine from the table
above and only its intra-run ratios carry over. On that machine the fold
control (`dispatch: no sink, no hook`) read 0.069 µs before the draft getter
and 0.077 µs after: the prototype getter, untouched, is the difference. The
state has 20 items.

| file                | group | bench                         | mean    | against its spread twin |
| ------------------- | ----- | ----------------------------- | ------- | ----------------------- |
| `lib.bench.test.ts` | draft | dispatch: spread, top field   | 0.19 µs |                         |
| `lib.bench.test.ts` | draft | dispatch: draft, top field    | 0.64 µs | 3.3x                    |
| `lib.bench.test.ts` | draft | dispatch: spread, nested item | 0.26 µs |                         |
| `lib.bench.test.ts` | draft | dispatch: draft, nested item  | 2.05 µs | 8x                      |

A draft costs what the proxy costs: a few hundred nanoseconds at the top
level, about two microseconds for one nested write, both under the price of
forking one command leaf. A handler that never reads `draft` pays the getter
lookup alone.
| `lib.bench.test.ts` | mount cycle | createFeatureStore + start + stop: no layer | 20.37 µs |
| `lib.bench.test.ts` | mount cycle | createFeatureStore + start + stop: Layer.succeed | 25.21 µs |
| `lib.bench.test.ts` | mount cycle | createFeatureStore + start + stop: async Layer.effect | 28.52 µs |
| `subscriptions.bench.test.ts` | reconcile | fold with 1 stable keys: hook evaluated, nothing changes | 0.75 µs |
| `subscriptions.bench.test.ts` | reconcile | fold with 10 stable keys: hook evaluated, nothing changes | 2.40 µs |
| `subscriptions.bench.test.ts` | reconcile | fold with 100 stable keys: hook evaluated, nothing changes | 18.51 µs |
| `subscriptions.bench.test.ts` | reconcile | 10 keys, one rotates: stop one, start one, settle | 16.81 µs |
| `subscriptions.bench.test.ts` | reconcile | 100 keys, one rotates: stop one, start one, settle | 43.05 µs |
| `task.bench.test.ts` | Task.run | mode latest: 50 issues and settle | 850.00 µs |
| `task.bench.test.ts` | Task.run | mode every: 50 issues and settle | 581.19 µs |

What the numbers say:

- A fold is 0.2 µs. A live recorder sink adds nothing measurable; the console
  logger costs 0.7 µs per event on a silent console, with or without `diff`.
- A command leaf costs about 20 µs to fork and settle: one fiber, an exit
  observer attached with `fiber.addObserver`, and a `Settled` queue item. A
  batch scales linearly at 7 µs per extra leaf. `restart` is 14 µs per
  dispatch, the awaited interrupt included. (Measured with the earlier
  `Fiber.await` watcher fiber per leaf; the observer form measured 1.04x on
  one leaf, 1.8x on a batch of 100 and 1.56x on 100 restarts against a
  same-session baseline, 2026-09-20.)
- `Feature.run` pays 2.5 µs per seeded action for its `Effect.yieldNow`, and
  13 µs per action that emits once.
- Props validation and equivalence are linear in field count, about 0.1 µs per
  field each. A 30-field feature pays about 3 µs of validation per render,
  because `incoming` is a fresh object each time, and about 2 µs of
  equivalence per committed render, from the layout effect; a render React
  abandons pays only the validation.
- A mount cycle is 20 µs bare, 25 µs with a `Layer.succeed`, 29 µs with an
  asynchronous `Layer.effect`.
- The subscription diff costs 0.18 µs per declared key per fold when nothing
  changes; one key rotating costs 17 µs at 10 keys and 43 µs at 100.
- `Task` `latest` costs 1.5x `every` for 50 back-to-back issues: the awaited
  cancel.
- In Chromium (`lib.stress.browser.test.tsx`, `console.info` lines under
  `--reporter verbose`): 250 sibling features mount in 44 ms wall, one
  commit; 1000 in 75 ms wall with 48 ms of render in one commit; 2000
  mount/unmount cycles under three names hold the heap at 47 MiB.

### Load shapes and pinned assertions

Counts are at `STRESS_SCALE=1`. Every test names its criterion; a pinned
defect is `it.fails` with a `HINT` above it naming the spec entry.

**Many mounts** (`lib.stress.test.ts`, `subscriptions.stress.test.ts`,
`lib.stress.browser.test.tsx`)

- 500 stores under one runtime start, dispatch and stop: every probe idle
  and unmounted after, 500 `Mounted`, 500 `Unmounted`, distinct instances.
- 200 stores sharing a root layer with one failing per-feature layer: the
  root acquired once, one `Defect` from `Mounted`, the other 199 fold
  normally, `runtime.dispose()` under 1 s.
- 200 stores declaring 5 keys each: 1000 `Started`, 1000 `Stopped` with
  reason `Unmounted`.
- 250 sibling components in Chromium mount in at most two commits and paint;
  a dispatch in one repaints only that one; unmount empties the document.
  1000 siblings is a probe, reported not gated.
- 250 subscribing components under `StrictMode`: 500 `Mounted`, 250
  `Unmounted` at mount, 500 `Started`, 250 `Stopped` at mount and 500 after
  unmount, none `Died`.

**High-frequency sources**

- A command emitting 100k actions folds all of them under 3 s. Each emission
  is its own fold and its own subscriber notification; a React consumer is
  offered that many re-renders. Recorded, not hidden.
- An output handler dispatching 10k actions re-entrantly drains them in the
  one fold that emitted the output: `pending` peaks at 10k, one notification.
- A subscription emitting 100k elements from `Stream.range` folds all of them
  under 3 s and then reports `Stopped` with reason `Completed`, staying
  booked until undeclared.
- 10 sources emitting 10k each interleave without losing per-key order.
- A sink that throws is called once and costs nothing after.
- 10k commands offered before `start()` are buffered and all run. `buffered`
  is bounded by the caller alone, by design.
- 10k `sync()` calls with alternating props fold 10k `PropsChanged`.

**Deep async churn**

- 10k `restart` dispatches into one key: at most one live fiber at any
  sample, book empty after `cancel`, no defect. A fiber is unbooked by its
  exit observer, synchronously, so `fibers` and `live` agree unless an
  interrupt is deferred by an uninterruptible region; `live` is the number
  that matters.
- 1k restarts whose cancelled leaf has a 1 ms finalizer finish under 3 ms per
  cycle: the `Cancel` awaits each finalizer on the mount loop.
- `stop()` with 100 commands in flight drains them, runs the `Unmounted`
  command with the feature layer alive, and releases under 500 ms.
- 1k start/stop cycles without settling between keep `Mounted` and
  `Unmounted` paired.
- An `on<Tag>` handler dispatching during a teardown drain has its command
  either run on the closing mount or reported `dropped: true`, exactly one.
- 1k commands whose builder throws each raise one `Defect` and fold `Error`;
  a command that dies after emitting folds the emission, then one `Error`.
- 100 subscriptions dying on the first tick, and 100 dying after ten, each
  report one `Died` and fold one `Error`, and stay booked until undeclared.
- 500 sources dying on the first tick under the store, and 1000 under `run`,
  are all reported. The fork loop crosses the scheduler's op-budget yield,
  and a body that runs before the mount fiber's booking books itself first.
- `Task` `latest` resolves once for 1k back-to-back issues; `every` resolves
  1k times.
- Pinned, `it.fails`: a hung uninterruptible finalizer on `Cancel` stalls the
  next command (Known limitations); `run` never resolves with a
  never-completing command in flight (Known limitations).
- Property tests (`lib.differential.stress.test.ts`, `Arbitrary` from `effect/unstable/arbitrary`, 200 runs):
  `run` and a hand-driven store agree on final state and emission order for
  sequences of commands that complete before the next action; after any
  sequence including `restart` and `cancel` the books are empty and the log
  equals what was emitted; `restart` never leaves two live fibers under one
  key; `Schema.toEquivalence` is reflexive on structural clones, so `sync`
  folds no `PropsChanged` for one.

**Long sessions**

- 10k create/start/dispatch/stop cycles, with and without a scoped
  per-feature layer: a sentinel reachable only through each store's closure
  is collected for at least 99 percent of cycles, heap growth over the last
  five of eight rounds under 2 MiB, layer acquires equal releases.
- 10k cycles with 3 keys each: 30k `Started`, 30k `Stopped`, same heap and
  sentinel criteria.
- The console sink's elapsed-clock map stays under 512 entries across mounts
  that never unmount.
- 10k drafting folds on one store, in eight rounds of push-then-trim, leave
  the state empty, heap growth over the last five rounds under 2 MiB and no
  draft retained: the open-draft `WeakSet` is emptied at every close.
- 2000 mount/unmount cycles in Chromium under three names: the `useFeature`
  context registry does not grow with mounts, heap growth over the last five
  rounds under 2 MiB.
- 50 abandoned transitions held 50 ms with an emitting subscription never
  start the discarded key: zero `SubscriptionStarted` for it, zero
  `SubscriptionStopped` for the committed key, and the committed feed emits at
  least once through every hold (measured 6 ticks per 50 ms hold). See
  Findings.

### Findings

- **A `key` on a feature component failed props validation in development.**
  React's development build defines a non-enumerable `key` getter on a keyed
  element's props, and `decodeUnknownSync` with `onExcessProperty: "error"`
  reads own property names, so every list of features threw `Expected no
excess property at ["key"]` in dev and worked in production. Fixed:
  `splitOutputProps` copies a props object carrying a `key` or `ref` own
  property through `Object.keys`. Asserted by `lib.stress.browser.test.tsx`
  "a feature rendered with a key passes props validation"; criterion above.
- **Discarded-render churn was per emission, not per abandoned render.**
  Measured at 1, 3, 7 and 18 restarts of the discarded key for a render held
  0, 12, 50 and 150 ms with a source ticking every 5 ms, while `store.sync`
  folded in the render body. Fixed by moving the comparison, the fold and the
  baseline advance into a layout effect: an abandoned render never touches
  the store, so the discarded key is never started. Asserted by
  `lib.stress.browser.test.tsx` "50 abandoned transitions…" at zero starts;
  the design is under Deferred decisions, `store.sync` folding during
  render, executed.
- **A subscription that died before its key was booked was never reported**,
  in the store and in `run`. Fixed first by having the forked body book its
  own fiber; now the book books the fiber and then attaches an exit observer,
  and an observer attached after the exit fires at attach
  (`lib.probe.test.ts`). Asserted by `subscriptions.stress.test.ts`;
  criterion in `subscriptions.specs.md` under Failure.
- A subscription that died and is later undeclared reports a second
  `SubscriptionStopped`, reason `Undeclared`. Kept: the events describe the
  declared set. Noted in `subscriptions.specs.md` Expected Behavior.
- Every emission from a command or subscription is its own fold and its own
  notification. Not a defect; the number a React consumer pays.

## Known limitations

- **A `Cancel` awaits the interrupted fibers' finalizers on the mount's run
  loop.** That await is what guarantees a `Batch` can sequence a `Cancel`
  before the command replacing it — but it means an uninterruptible finalizer
  that hangs stalls all subsequent command processing for that feature.
  Finalizers are expected to be brief; the 5s teardown bound catches the
  unmount case, and nothing bounds the in-mount case today.
- **`run` resolves at _command_ quiescence, so a never-completing command
  holds it open.** `Command.effect((d) => Effect.never)` pins the in-flight
  count and `run` never resolves. This is the definition of a command since
  the `Cmd`/`Sub` split (`subscriptions.specs.md`): a subscription fiber
  counts for nothing, and a command that never completes is a subscription
  written in the wrong place. The test asserts it as the control beside the
  subscription subject. What `run` does not do for subscriptions — await an
  asynchronous emission — is that spec's known limitation.
- **An action a parent takes in response to a child's output is not attributable
  to that output.** An output leaves through a plain React callback into
  arbitrary user code, so the runtime cannot know what the parent did next. The
  devtools event stream therefore carries an `Output` event and a `Dispatch`
  cause on whatever the parent dispatched, and never claims an edge between
  them — a devtools UI can draw that edge, the runtime cannot assert it. This is
  the residue of the old `cause: { _tag: "Output" }` variant, which was deleted
  rather than left as an unfillable optional field. See `devtools.specs.md`.
- **A spread of a draft is unreadable after the fold.** The drafter revokes
  every proxy at finish, and a copy made with `{ ...draft }` holds proxies
  for its nested values. Reading one throws. `Task.start` branches on
  `isLiveDraft` for exactly this reason; user code that copies a draft has
  no such guard. The rule is: write into the draft and return it, or leave
  it alone.
- **A custom drafter is not seen by folds before the root context exists.**
  The store resolves `Drafter` from `runtime.cachedContext`, so under an
  async root layer the folds that happen before it resolves draft with the
  default. The same blind window `devtools.specs.md` documents for the sink.
  With the default drafter nothing is observable.
- **A `ReadonlyArray` does not assign into a drafted array field.** A
  drafted array is `Array<E>`; a `Schema.Array` payload decodes to
  `ReadonlyArray<E>`; TypeScript refuses the assignment. The docs write
  `draft.hits = [...hits]`, a shallow copy the fold freezes anyway.
  `Task.resolved` and `Task.rejected` return their value at its `Draft` type
  so the common `draft.field = Task.resolved(value)` needs no copy; a general
  `asDraft` cast was considered and not added, since a copy needs no import
  and reads as what it is. Revisit if the copy shows up in a hot handler.
- **`Draft<T>` treats any object with a `pipe` method as atomic.** That is
  how every Effect data type is kept immutable at the type level without
  naming them, and it also freezes a user's own class that happens to have
  a `pipe`. The drafter itself only drafts plain objects, arrays, maps and
  sets, so the type and the runtime agree on those.

## Open work

Five items, all closed and kept for their cross-references. Items 4 and 5
were found by the review of the command-leaf pass and **rejected for that
pass**: both are byte-identical at the commit before it, so neither is a
regression the leaf change introduced, and both needed a decision about
intended behaviour rather than a patch.

### 1. Re-arming a mount that died, from `component` — **closed**

A feature layer that fails to build kills the mount fiber. The store clears its
mount and arm flag, so a following `start()` _can_ build fresh cells — but
`component` arms with `useEffect(() => { store.start(); return () => store.stop(); }, [store])`
and `store` never changes, so nothing calls one. Every command after that is
dropped for the life of the component, including the Retry the `Error` handler
just rendered. A driver holding the store recovers; a React subtree does not.

Candidates: a store-bumped `version` as a dep of the arming effect (simple, but
a permanently failing layer retries forever), or a demand-driven re-arm inside
the queue-offer path (fires only when work arrives, but re-enters `fold` from
inside a fold, so the guard has to be shown to hold).

Must not break: the silent drop after a _normal_ unmount. Done when a browser
test drives a failing layer, clicks Retry, and the retried command runs — plus a
test that a permanently failing layer does not spin.

Closed by the demand-driven candidate, narrowed to **dispatch-caused** work.
`catchCause` marks the store `dead` beside `release()`; `offer` re-arms only
when `dead`, not `active`, and the command's fold was caused by a `Dispatch`.
That one narrowing settles both worries at once: `Mounted`'s own command on
the rebuilt mount is lifecycle-caused and cannot re-enter `start`, and a
permanently failing layer rebuilds once per user action, never on its own.
The re-entrancy guard holds because `start`'s `fold({ _tag: "Mounted" })`
lands in `pending` and folds after the action that re-armed, with the
retried command already on the new queue. A layer that fails synchronously
has released the mount again by the time `start` returns; `offer` reads
`mount` afresh and drops. `stop` on a dead mount now folds and reports
`Unmounted` and clears `dead`, which also closes the devtools known
limitation about a dead mount's missing terminal event. The `Error` action
gained `from` in the same pass, so a handler can back off on `"Mounted"` and
carry on for one bad command. Browser test: `lib.browser.test.tsx`, "a Retry
from the `Error` handler rebuilds a failed layer".

### 2. What unmount owes work already in flight — **closed**, by `subscriptions.specs.md`

Teardown interrupts every in-flight fiber before interpreting the `Unmounted`
command, unconditionally, so `start(); dispatch(Go); stop()` loses a 50ms effect
roughly 0ms in. The sweep is what makes teardown terminate at all — a
subscription never completes — so the question is not whether to sweep but which
work the sweep may kill.

Candidates: sweep only long-lived work once the `Cmd`/`Sub` split lands; or give
in-flight work a grace window inside the existing teardown budget; or keep the
sweep and document that flush-on-exit belongs in `Unmounted`, which is the
current de-facto answer.

Must not break: teardown termination, and the teardown bound staying a
whole-teardown bound rather than a per-hop one.

Decided by the first candidate, once the split makes it expressible. The
answer, verbatim from `subscriptions.specs.md`: **commands finish,
subscriptions stop, the `Unmounted` command runs regardless and may `cancel`
what it does not want to wait for, the whole bounded at the existing 5s, an
overrun is one defect (`from: "Unmounted"`), and the scope closes anyway.**
Teardown order becomes: interrupt subscription fibers → interpret the
`Unmounted` command → drain to quiescence. Flush-on-exit stops being a rule
because it is the default; kill-on-exit is the opt-in
(`Unmounted: () => [state, Command.cancel("slow")]`). Both must-not-breaks
hold: the sweep over subscriptions is what terminates teardown, and the
bound stays whole-teardown. What it costs is recorded there under Expected
Behavior — a command finishing during a StrictMode remount folds into the
remounted store, so `Mounted`'s command must fold idempotently — and under
Known limitations. Closed: that spec's "Store and teardown" boxes are
checked (`subscriptions.test.ts` part four; under React,
`subscriptions.browser.test.tsx` "unmount stops the subscription and lets a
pending command finish").

### 3. `RuntimeOptions.onEvent` is accepted and ignored — **closed**

`createRuntime` never emitted a `DevtoolsEvent`, but the in-repo examples of
the time (`src/examples/app.tsx` and `cart.tsx`, since removed) presented it as
working, so a reader copying the example installed an observer that never
fired and got no signal.

Closed by the third option — wire it, as a feature. `RuntimeOptions` and the
second parameter are **removed outright**; observation is a `Context.Reference`
sink installed through the root layer, resolved synchronously because the fold
is synchronous. `src/devtools.ts`, spec'd in `src/devtools.specs.md`.
The number is kept rather than the item deleted, so the cross-references to
items #2, #4 and #5 elsewhere in this file keep meaning what they say.

Two things it did **not** close, both recorded under Known limitations in
`devtools.specs.md` rather than here: nothing is reported before `start()`
(the root context does not exist until the first `runFork`), and a mount whose
fiber _died_ emits no `Unmounted` — which is item #1's to fix, since the same
`release()` is why the store cannot re-arm from `component` either.

### 4. `Feature.run` discards a dying command — **closed**

`commandInterpreter`'s `onExit` is optional, and `run` was the caller that omitted
it. `forkLeaf` forks and returns, so nothing awaits the fiber: a feature whose
command dies comes back from `run` with the state it already had, an empty
`emitted`, and no failure. Confirmed by running it —
`Bump: () => [state, Command.effect(() => Effect.die(new Error("kaboom")))]`
resolves clean. `createFeatureStore` passes the hook and routes a non-interrupt
exit to the `Error` handler, so the two callers of the one interpreter disagree
about the one thing the hook exists for, and the interpreter's own JSDoc says
that without it "every defect from a command is discarded silently".

The consequence is worse than a missing report: `run` is the spec's headless way
to test a feature, so _"given a failing command, this feature recovers"_ is
currently untestable through it — a test written that way passes vacuously.

The decision it needs first: what `run` should _do_ with a defect. Route it to
the `Error` handler, matching the store, and a feature that handles it looks
identical either way from the outside. Fail the returned Effect, and a test can
assert on it, but `run` stops being total and every existing caller's type
changes. Collect into a `defects` array beside `emitted` and `outputs`, and it
stays total and stays assertable, at the cost of a third output nobody asked for
yet.

Closed by the third option, plus the first: `run` passes `onExit`, collects
every non-interrupt death into `defects` (`RunDefect`: `from`, the squashed
`error`, `handled`), and — when the feature has an `Error` handler and the
dying command was not that handler's own — queues the `Error` fold before the
fiber's `settled` entry, so the drain loop cannot reach quiescence between the
death and the recovery. "This feature recovers" is now a `state` assertion and
"this command failed" a `defects` assertion; the return type gains one field
and every existing caller still compiles. What `run` still does not do is
report to devtools — that is `devtools.specs.md`'s open item, unchanged.

### 5. Buffered work can precede `Mounted` — **closed**

`start()` flushes `buffered` into the queue before folding `Mounted`. `sync`
ran in the render body while `start` runs in a passive effect, so a props
change between the first render and the mount effect folded `PropsChanged`
first — its command was buffered, and the flush put it ahead of `Mounted`'s.
Confirmed at the time: `sync({p:1}); sync({p:2}); start()` logged
`["props-cmd", "mounted-cmd"]`.

This contradicted the lifecycle-order criterion above, which was marked `[x]`
and says `Mounted` comes first. The criterion described the intent, and the
intent is right; the code had a window it did not cover. A `Mounted` handler
seeding state that a `PropsChanged` command depends on saw them inverted.

Closed by the `store.sync` redesign under Deferred decisions, twice over.
Under React the window is gone: `sync` runs in a layout effect, and React
flushes pending passive effects (`start`, `Mounted`) before the render that
would carry a later commit's props. On the store itself `sync` before the
first `start` records and raises nothing, so the hand-driven sequence now
logs `["mounted-cmd"]` with `Mounted`'s snapshot carrying `{p:2}`, and the
first `sync` after `start` compares against that. Both are tests now: the
node case in `lib.test.ts` ("before the first start, records without
raising") and the React case in `lib.browser.test.tsx` ("`Mounted` folds
before a `PropsChanged` that lands in the first commit"). What remains of
the buffer is the documented path for a `dispatch` before `start`, a
descendant's layout effect for instance, whose command still runs ahead of
`Mounted`'s; that is a dispatch, not an ambient input, and the lifecycle
criterion does not speak to it.

## Deferred decisions

### A `mutate(handler)` wrapper for drafting — rejected

The first shape for drafts: `Typed: mutate(({ query }, { state }) => { state.query = query; return search.run(query); })`,
a wrapper that opens the draft, runs the handler and returns `Next`. Rejected
on two counts, both verified with tsc against `define().create()`. Inference
through `create`'s `U extends Reducer<…, any>` constraint infers the
wrapper's `R` as `never`, so a service the returned command needs never
reaches `component`; inferring the whole command type and extracting `R`
with a conditional loses it the same way, for the reason the `ServiceOf`
comment gives about the `Command` union. And a wrapper on the definition
object (`Def.mutate(…)`) breaks the `define(…).create(…)` chain. The getter
on the snapshot needs no generic: `draft` is typed off `Reducer` itself and
`R` rides the ordinary `Next` return.

### `Drafter` as a required service with `mutative` an optional peer — rejected

The second shape: no default, a subpath `@wych/react/draft/mutative`, and
`Draft<T>` branded so a returned draft carries `Drafter` into `R`, making a
runtime without one a compile error at `component`. Sound, and rejected once
drafting became the documented default style: every `createRuntime`, every
`run` layer and every hand-driven `reduce` in the docs would carry the
drafter, tutorial chapter one included. A `Context.Reference` with the
Mutative default keeps every call site as it was; the override stays.

### One `dispatch`, routed by tag — no `Command.output`

`Command.output` and its compile-error-on-an-internal-message criterion are
removed, and outbound messages go through the same `dispatch`, routed by `_tag`
against the declared output cases — which is already how routing works and
already own-keys checked. The channel brand keeps its declaration-time jobs
(the slot types, `Disjoint`, `OutputProps`); it stops being checked
at the command call site, where it never affected routing anyway.

**Partially executed.** `dispatch` takes `(Message, payload)` as well as a built message, so every send site has the one shape `Command.output(Message, payload)` already had. `dispatch` now carries `Emit<A, O>` everywhere — the
command dispatcher always did, and `render`'s dispatch is widened to match, so
a passthrough view announces without a mirror action. A purely type-level
change: the store routed by tag all along. `Command.output` **stays**, as
sugar over `Command.effect((dispatch) => dispatch(message.make(payload)))`;
removing it and the brand's call-site check remains deferred — it still
touches every example.

### `store.sync` folding during render — **executed**

`sync` used to compare props and hooks by value and, when either moved, fold
`PropsChanged` / `HookChanged` **in the render body**, advancing its
comparison baseline in the same call. That was a store mutation during render:
a render React abandoned had already acted on props that never committed, and
with a subscription keyed on those props and emitting during the hold, every
emission forced a synchronous re-render of the committed tree, whose `sync`
folded the committed props back, after which React retried the transition and
`sync` folded the abandoned props again. Measured at 1, 3, 7 and 18 restarts
of the discarded key for holds of 0, 12, 50 and 150 ms with a 5 ms tick.

The one-line fix ("fold in an effect") was not implementable as written
because it left the baseline advance in render, where an abandoned render
would advance it and the committed render that followed would see no change.
So the baseline moved with the fold. The design, as landed:

- **Comparison** happens in `store.sync`, called from a `useLayoutEffect`
  with no dependency list: once per committed render, never for a render
  React discards. Nothing in the render body reads or writes the baseline.
  The candidate of comparing in the render body and folding in the effect
  was evaluated and rejected: the effect has to compare anyway (a result
  computed in render is only valid for that render's own commit, and the
  effect cannot tell which render it belongs to without comparing), so a
  render-body comparison is a second equivalence per commit with no consumer.
- **The fold** happens in that same layout effect: `PropsChanged`, then
  `HookChanged`, each notifying subscribers as any fold does. A fold that
  moved state makes `useSyncExternalStore` schedule a synchronous re-render,
  which React flushes at the end of the same commit, before the browser
  paints. The `syncing` flag no longer suppresses notification; it only keeps
  `sync`'s two folds to one subscription diff.
- **The baseline advances** inside `sync`, with the fold, from the committed
  props and hooks. Before the first `start`, `sync` only records: `Mounted`
  is the first lifecycle action a feature ever folds, and its snapshot
  carries the props and hooks in force at mount. After `stop` or a dead
  mount, `sync` folds as it always did; its command is dropped as any
  lifecycle command is then.
- **An abandoned render costs the store nothing.** Props validation
  (`useMemo` on props identity) and the `useUnsafeHooks` call still run,
  because they are React's. The abandoned render's subscription keys are
  never started, and a transition that suspends and later commits starts its
  new key on the commit that shows it, not on its first render attempt.
- **A props-driven change costs two renders and one paint.** Render N carries
  the new props with the old state and commits; the layout effect folds; the
  synchronous re-render N+1 commits the new state; the browser paints once,
  after N+1. Measured in `lib.browser.test.tsx` "a props change costs two
  renders and one frame, measured": a `MutationObserver` sees the DOM pass
  through the intermediate value and the first `requestAnimationFrame` after
  the click reads the final one. The previous design paid one render; the
  second is the price of never touching the store from render.
- **Hook order in `Mount`** is `useSyncExternalStore`, `useUnsafeHooks`, the
  layout effect, the mount effect. The old "`useSyncExternalStore` after
  `sync`, deliberately" note is void: no fold runs during render, so there is
  nothing for the hook's post-render consistency check to catch, and the
  order between the two is immaterial.

Two entries close with it. `useUnsafeHooks` no longer lags: the hook is called
with the state the render reads, a fold that moves state re-renders
synchronously, the hook re-evaluates against the new state, and the next
layout effect raises `HookChanged` if its value moved, all before paint. A
`HookChanged` handler whose state change moves the hook's value again has no
fixed point and hits React's nested-update limit; that is the reducer's to
own, and the same rule the docs already give for a hook returning a fresh
object. And Open work item 5 is closed: the window between the first render
and the mount effect no longer holds a fold, and `sync` before the first
`start` records without raising, so `Mounted` folds before any `PropsChanged`
on the store as well as under React.

Pinned by `lib.stress.browser.test.tsx` "50 abandoned transitions held 50 ms
with an emitting subscription never start the discarded key": zero starts of
the discarded key, the committed key never interrupted, the emissions never
paused.

This supersedes old open item #5 ("the `useSyncExternalStore`-after-`sync`
ordering has no discriminating test"), which the previous spec rewrite
promoted into an acceptance criterion; with the fold out of render that
criterion is retired rather than tested.

### Subscriptions split from commands (`Cmd` / `Sub`) — **retired**, landed

Elm's runtime asks the feature for its subscriptions on every update and
diffs them: a subscription is a _declaration_, and stopping one means no longer
declaring it. Commands are one-shot; subscriptions are a set the runtime
maintains.

Collapsing both into `Command` is what makes `run`'s non-termination
unfixable — the runtime cannot tell "work that will finish" from "work that is
supposed to run forever", so quiescence cannot be defined. It also makes unmount
guess (open work #2).

Was deferred because it is a second ADT, a diffing step, and a second hook,
and it should land against the `Effect` leaf rather than at the same time as
it. The leaf landed, then the split, as `subscriptions.specs.md`: a
`Subscription` value with `Command.effect`'s leaf, a `subscriptions(snapshot)`
hook on `create` returning a string-keyed record, a keys-only diff after every
drain, `run` resolving at command quiescence, and the teardown order above.
`Command` is untouched. The decisions that spec makes and rejects — key
equality, no automatic restart, `cancel` not reaching a subscription — are
recorded there, not here.
