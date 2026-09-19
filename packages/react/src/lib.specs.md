# lib.ts — TEA-style feature runtime core

## Overview & Purpose

A **feature** is declared with `define` and built with `create`: schema-typed props and state, a tagged
action vocabulary, an optional outbound output vocabulary, optional ambient
hooks, and a reducer. The reducer is pure — it returns the next state and,
optionally, a `Command` describing work to do. The runtime interprets commands
as Effects.

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

## Acceptance Criteria

`[x]` holds today. The command-leaf pass landed, and what it did not do is in
Open work and Deferred decisions rather than left as an unchecked criterion
here. The devtools pass closed the last two (its criteria live in
`devtools.specs.md`), and the flat-group-namespace + `Command.restart` pass
landed with every box checked again.

### Vocabularies (`Action`, `Action.output`, `Action.of`)

- [x] `Action("Tag", fields)` / `Action.output("Tag", fields)` constructs a `Schema.TaggedStruct` branded with its channel (`"internal"` vs `"outbound"`).
- [x] `Action.of([...])` builds a branded tagged union exposing `cases`, `guards`, `match`, `mapMembers`, and a `make` per case.
- [x] `Action.of` infers the channel from its members' brand; there is no per-channel `of`.
- [x] `Action.of` rejects a member list mixing channels, at the call rather than at `define`.
- [x] A vocabulary built with `.of` nests inside another `.of`, and the outer `cases` include the flattened inner tags.
- [x] The channels are not mutually assignable in either direction.
- [x] A reserved `LifecycleTag` (`Mounted`/`PropsChanged`/`Error`/`Unmounted`/`HookChanged`) as a message tag is a compile error.

### `Command`

- [x] `Command.none` is the `{ _tag: "None" }` no-op.
- [x] `Command.effect((dispatch) => Effect<unknown, never, R>)` is the only leaf. A command that emits nothing ignores the parameter.
- [x] `Command.stream` and the `Stream` variant are removed. A long-lived source is `Stream.runForEach(source, dispatch)` inside the effect, so the whole `Stream` vocabulary stays available one call earlier.
- [x] `Command.keyed(key, command)` names the group a command's fibers book under — the whole address, outermost wins. Also curried (`Command.keyed(key)`) and so pipeable. An unkeyed command books under its issuing action's tag.
- [x] `Command.ignore`, `Command.queue`, the `Policy` type and the `Guarded` node are removed.
- [x] `Command.restart(name, command)` returns — as pure sugar, not a policy: it constructs exactly `Command.batch(Command.cancel(name), Command.keyed(name, command))`. Also curried (`Command.restart(name)`) and so pipeable.
- [x] `Command.batch(...commands)` interprets its members in order under one context. With no policy there is no supersession question and nothing to decide.
- [x] `Command.cancel(name)` interrupts the one group booked under `name`, whatever action tags forked its members. The fiber book is a flat map by name — no tag level, no delimiter encoding.
- [x] Bare-tag `cancel("Tag")` reaches only the **unkeyed** fibers of that tag; work forked under `keyed(name)` is addressed by `name` alone.
- [x] Cancelling work started from several action tags under one `keyed(name)` is one line — `cancel(name)` — naming no foreign tag.
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
- [x] Lifecycle order: `Mounted` once per mount, then `PropsChanged`/`HookChanged` as ambient inputs change, then `Unmounted` at teardown. _With one uncovered window: a props change landing between the first render and the mount effect buffers its command ahead of `Mounted`'s. See open work #5._
- [x] `PropsChanged`/`HookChanged` are detected **by value** — props via `Schema.toEquivalence`, hooks via `Equivalence.Record(Equivalence.strictEqual())`.
- [x] `store.sync` folds during render, so a props-driven change paints on the render that carried the props. Moving the fold into an effect is **deferred** — see Deferred decisions.
- [x] `store.sync` is idempotent: called twice with equivalent props and hooks it raises nothing the second time, so a discarded render costs nothing.
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
- [x] A transforming props schema is accepted: `define` normalizes it to its `Type` side with `Schema.toType`, so a codec field surfaces to `initialState`, the reducer and `render` as its decoded `Type`, the parent passes decoded values, and the wire shape is rejected by `validateProps` rather than decoded.
- [x] A props schema declaring `children: Children` surfaces the field to `initialState`, the reducer and `render` as `ReactNode`, optional under `Schema.optionalKey` and as the given function type under `Children.as<T>()`.
- [x] `Command<Narrow>` stays assignable to `Command<Wide>` under the callback leaf, and `Command.none: Command<never>` stays the bottom. `Dispatcher<A>` is contravariant in `A` and sits in a parameter position — contravariant again — so the two compose to covariant. **The existing covariance test passes unchanged.**
- [x] `Command.effect` carries `R` out of the effect it is handed. `A` has no inference site of its own, so it defaults to `never`: a command that emits nothing is `Command<never, R>` and fits every slot. Passing a bare `Effect` — the pre-redesign shape — no longer compiles, and neither does an effect with an open error channel.
- [x] Inside a handler, `dispatch` is typed by the feature's own vocabulary: `A` arrives from the contextual type of the handler's return. An undeclared tag and a declared tag with the wrong payload are both compile errors.
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

**How `A` reaches the leaf.** `A` appears only inside `Dispatcher<A>`, in a
parameter position, so nothing in the argument can infer it — it is resolved from
the contextual type of the call, which the reducer's return type supplies through
`create`'s `U extends Reducer<…>` constraint. Written standalone, with no
contextual type, `A` falls back to `never` and `dispatch` accepts nothing; the
call site names it (`Command.effect<Action>(…)`). The spec's examples rely on the
contextual path, and a type test compiles each of them to say so.

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

- Effect 4 beta, one pinned version.
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
tests. Fixtures and probes are in `src/__fixtures__/stress.ts`.

### How to run

From `packages/react`:

    vp run bench             # against bench/baseline.json, informational ratio column
    vp run bench:baseline    # rewrite bench/baseline.json
    vp run stress            # node then browser
    vp run stress:node       # STRESS_SCALE=4 for a headroom run
    vp run stress:browser

### Baseline

Written 2026-09-19 on an AMD Ryzen 7 5700X3D, Node v24.21.0,
`effect@4.0.0-rc.112`, React 19.2.8, headless Chromium. Indicative only:
tinybench varies 10 to 20 percent between runs and the compare column is a
prompt to look, not a gate. Async benches include an `await` on the probe
between iterations.

| file                          | group            | bench                                                      | mean      |
| ----------------------------- | ---------------- | ---------------------------------------------------------- | --------- |
| `devtools.bench.test.ts`      | fold with a sink | dispatch: counting sink                                    | 0.23 µs   |
| `devtools.bench.test.ts`      | fold with a sink | dispatch: console sink, diff off                           | 0.95 µs   |
| `devtools.bench.test.ts`      | fold with a sink | dispatch: console sink, diff on                            | 1.03 µs   |
| `devtools.bench.test.ts`      | fold with a sink | dispatch: no sink (control)                                | 0.21 µs   |
| `lib.bench.test.ts`           | fold             | dispatch: no sink, no hook                                 | 0.22 µs   |
| `lib.bench.test.ts`           | commands         | Command.effect: fork one leaf and settle                   | 21.02 µs  |
| `lib.bench.test.ts`           | commands         | Command.batch: 1 leaves and settle                         | 20.88 µs  |
| `lib.bench.test.ts`           | commands         | Command.batch: 10 leaves and settle                        | 84.19 µs  |
| `lib.bench.test.ts`           | commands         | Command.batch: 100 leaves and settle                       | 731.88 µs |
| `lib.bench.test.ts`           | commands         | Command.restart: 100 dispatches into one key, then cancel  | 1.4 ms    |
| `lib.bench.test.ts`           | Feature.run      | 10k seeds, no commands                                     | 25.2 ms   |
| `lib.bench.test.ts`           | Feature.run      | 10k seeds, each emits one action                           | 135.9 ms  |
| `lib.bench.test.ts`           | props            | Schema.toEquivalence: 3 fields, equal by value             | 0.17 µs   |
| `lib.bench.test.ts`           | props            | decodeUnknownSync: 3 fields                                | 0.67 µs   |
| `lib.bench.test.ts`           | props            | Schema.toEquivalence: 30 fields, equal by value            | 1.78 µs   |
| `lib.bench.test.ts`           | props            | decodeUnknownSync: 30 fields                               | 3.24 µs   |
| `lib.bench.test.ts`           | props            | Schema.toEquivalence: 300 fields, equal by value           | 26.11 µs  |
| `lib.bench.test.ts`           | props            | decodeUnknownSync: 300 fields                              | 53.07 µs  |
| `lib.bench.test.ts`           | props            | store.sync: 30 fields, equal props                         | 1.93 µs   |
| `lib.bench.test.ts`           | props            | store.sync: 30 fields, one field changed                   | 0.60 µs   |
| `lib.bench.test.ts`           | mount cycle      | createFeatureStore + start + stop: no layer                | 20.37 µs  |
| `lib.bench.test.ts`           | mount cycle      | createFeatureStore + start + stop: Layer.succeed           | 25.21 µs  |
| `lib.bench.test.ts`           | mount cycle      | createFeatureStore + start + stop: async Layer.effect      | 28.52 µs  |
| `subscriptions.bench.test.ts` | reconcile        | fold with 1 stable keys: hook evaluated, nothing changes   | 0.75 µs   |
| `subscriptions.bench.test.ts` | reconcile        | fold with 10 stable keys: hook evaluated, nothing changes  | 2.40 µs   |
| `subscriptions.bench.test.ts` | reconcile        | fold with 100 stable keys: hook evaluated, nothing changes | 18.51 µs  |
| `subscriptions.bench.test.ts` | reconcile        | 10 keys, one rotates: stop one, start one, settle          | 16.81 µs  |
| `subscriptions.bench.test.ts` | reconcile        | 100 keys, one rotates: stop one, start one, settle         | 43.05 µs  |
| `task.bench.test.ts`          | Task.run         | mode latest: 50 issues and settle                          | 850.00 µs |
| `task.bench.test.ts`          | Task.run         | mode every: 50 issues and settle                           | 581.19 µs |

What the numbers say:

- A fold is 0.2 µs. A live recorder sink adds nothing measurable; the console
  logger costs 0.7 µs per event on a silent console, with or without `diff`.
- A command leaf costs about 20 µs to fork and settle: two fibers (the leaf and
  its `Fiber.await` watcher) plus a `Settled` queue item. A batch scales
  linearly at 7 µs per extra leaf. `restart` is 14 µs per dispatch, the
  awaited interrupt included.
- `Feature.run` pays 2.5 µs per seeded action for its `Effect.yieldNow`, and
  13 µs per action that emits once.
- Props validation and equivalence are linear in field count, about 0.1 µs per
  field each. A 30-field feature pays about 5 µs per render for both, on every
  render, because `incoming` is a fresh object each time.
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
  sample, book empty after `cancel`, no defect. Interrupted fibers stay
  booked until their watcher's cleanup runs, so the book can hold many exited
  fibers mid-batch; `live` is the number that matters.
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
- Property tests (`lib.differential.stress.test.ts`, `FastCheck`, 200 runs):
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
- 2000 mount/unmount cycles in Chromium under three names: the `useFeature`
  context registry does not grow with mounts, heap growth over the last five
  rounds under 2 MiB.
- Pinned, `it.fails`: 50 abandoned transitions held 50 ms with an emitting
  subscription restart the discarded key at most twice each (see Findings).

### Findings

- **A `key` on a feature component failed props validation in development.**
  React's development build defines a non-enumerable `key` getter on a keyed
  element's props, and `decodeUnknownSync` with `onExcessProperty: "error"`
  reads own property names, so every list of features threw `Expected no
excess property at ["key"]` in dev and worked in production. Fixed:
  `splitOutputProps` copies a props object carrying a `key` or `ref` own
  property through `Object.keys`. Asserted by `lib.stress.browser.test.tsx`
  "a feature rendered with a key passes props validation"; criterion above.
- **Discarded-render churn is per emission, not per abandoned render.**
  Measured at 1, 3, 7 and 18 restarts of the discarded key for a render held
  0, 12, 50 and 150 ms with a source ticking every 5 ms. Pinned by
  `lib.stress.browser.test.tsx` "50 abandoned transitions…"; the deferred
  `store.sync` decision below is corrected.
- **A subscription that died before its key was booked was never reported**,
  in the store and in `run`. Fixed: the forked body books its own fiber before
  `sub.effect` runs. Asserted by `subscriptions.stress.test.ts`; criterion in
  `subscriptions.specs.md` under Failure.
- A subscription that died and is later undeclared reports a second
  `SubscriptionStopped`, reason `Undeclared`. Kept: the events describe the
  declared set. Noted in `subscriptions.specs.md` Expected Behavior.
- Every emission from a command or subscription is its own fold and its own
  notification. Not a defect; the number a React consumer pays.

## Known limitations

- **`useUnsafeHooks` sees the pre-`sync` state.** `component` calls the hook spec
  with the committed state read _before_ `store.sync` folds
  `PropsChanged`/`HookChanged`, and a sync-driven fold suppresses notification
  (the change paints on the same render), so a hook value derived from state
  can lag until the next dispatch or ambient change. A follow-up notification
  would cost the second render the render-body `sync` exists to avoid; this is
  part of the deferred `store.sync` redesign below, not a patch.
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

## Open work

Five items. Items 1, 2, 3 and 4 are closed and kept for their
cross-references; item 5 still needs a decision before it needs code. Items 4 and 5
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

### 5. Buffered work can precede `Mounted`

`start()` flushes `buffered` into the queue before folding `Mounted`. `sync`
runs in the render body while `start` runs in a passive effect, so a props
change between the first render and the mount effect folds `PropsChanged`
first — its command is buffered, and the flush puts it ahead of `Mounted`'s.
Confirmed: `sync({p:1}); sync({p:2}); start()` logs `["props-cmd", "mounted-cmd"]`.

This contradicts the lifecycle-order criterion above, which is marked `[x]` and
says `Mounted` comes first. The criterion is what is wrong — it describes the
intent, and the intent is right; the code has a window it does not cover. A
`Mounted` handler seeding state that a `PropsChanged` command depends on sees
them inverted.

Not independent of the deferred `store.sync` work: the window exists _because_
`sync` folds during render while `start` runs in an effect. Moving the fold into
an effect closes it as a side effect, which is an argument for doing that piece
properly rather than special-casing the ordering here.

## Deferred decisions

### One `dispatch`, routed by tag — no `Command.output`

`Command.output` and its compile-error-on-an-internal-message criterion are
removed, and outbound messages go through the same `dispatch`, routed by `_tag`
against the declared output cases — which is already how routing works and
already own-keys checked. The channel brand keeps its declaration-time jobs
(`ChannelOf`, `SameChannel`, `Disjoint`, `OutputProps`); it stops being checked
at the command call site, where it never affected routing anyway.

**Partially executed.** `dispatch` now carries `Emit<A, O>` everywhere — the
command dispatcher always did, and `render`'s dispatch is widened to match, so
a passthrough view announces without a mirror action. A purely type-level
change: the store routed by tag all along. `Command.output` **stays**, as
sugar over `Command.effect((dispatch) => dispatch(message.make(payload)))`;
removing it and the brand's call-site check remains deferred — it still
touches every example.

### `store.sync` folding during render

`sync` compares props and hooks by value and, when either moved, folds
`PropsChanged` / `HookChanged` **in the render body**. That is a store mutation
during render, which a discarded render repeats — the value comparison is what
makes the repeat a no-op, and the reason the idempotence criterion above exists.
The alternative is `sync` reporting only _whether_ ambient inputs moved and
`component` folding in an effect, which costs a render: the change would paint on
the render after the one that carried the props.

**Deferred**, and not merely unscheduled. Two reasons. The blast radius is not
this pass's: it moves state into `component`, both browser tests and every
example's render timing, on top of a leaf migration whose own scope was already
trimmed for the same reason (see `Command.output`, below). And the one-line
statement of it is not implementable as written — it says the fold moves to an
effect but not whether the _comparison baseline_ moves with it, and the baseline
advance is itself a render-phase mutation, so leaving it behind fixes nothing.
It needs its own `/spec` pass rather than a box on this one.

**Known limitation, inherited by subscriptions.** An emitting subscription
during a suspending transition churns: `sync` folds the transition's props in
the render body and the diff starts the new key, the subscription's first
`dispatch` makes `useSyncExternalStore` force a synchronous re-render on the
sync lane, and that render commits the props React was about to discard, so
the key flips back and forth once per abandoned render. The browser case
"a discarded render's subscription is stopped by the committed one" uses a
non-emitting feed for that reason: with an emission the render is never
discarded and the case has nothing to show. Measured in
`lib.stress.browser.test.tsx`: the discarded key restarts once per emission
or two for as long as the abandoned render is held (1 restart at 0 ms, 3 at
12 ms, 7 at 50 ms, 18 at 150 ms with a 5 ms tick), so the churn is bounded
by the hold time and the emission rate, not by the keys involved. Fixed by
this redesign, not before it.

This supersedes old open item #5 ("the `useSyncExternalStore`-after-`sync`
ordering has no discriminating test"), which the previous spec rewrite promoted
into an acceptance criterion. The untested-ordering observation stands and is
recorded there; the redesign it proposed is what is deferred here.

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
