# subscriptions — long-lived sources as a declared set, diffed by key

## Overview & Purpose

Before this spec a feature had one kind of work: a `Command`, interpreted once, booked
under a name, ended by `cancel` or by finishing. A source that outlives every
render — a websocket, a presence feed, a `Stream.tick` — is written as a
command whose effect never returns, and its lifetime is managed by hand across
three lifecycle handlers: `Mounted` starts it, `PropsChanged` restarts it under
the same name, `Unmounted` cancels it (`docs/how-to/subscribe-to-a-stream.md`,
`docs/examples/presence-stream`, the Room example in
`docs/reference/lifecycle.md`).

Collapsing both kinds into one ADT and one `inFlight` counter is what
`lib.specs.md` records as the cause of two open problems: `Feature.run` cannot
define quiescence, because it cannot tell "will finish" from "runs until told
to stop" (its Known limitation, pinned by a test that asserts the hang), and
unmount has to interrupt every fiber unconditionally because it cannot tell
which ones would have finished (open work #2). The deferred decision
"Subscriptions split from commands (`Cmd` / `Sub`)" names the fix and says it
should land against the `Effect` leaf. The leaf shipped; this is the split.

Elm's shape, and for Elm's reason: a command is _issued_, a subscription is
_declared_. The runtime asks the feature for the set it wants right now, after
every fold, and diffs it against the set that is running — start the new keys,
stop the missing ones, leave the rest alone. Stopping a subscription means no
longer declaring it. Nothing about `Command` changes.

```ts
export const presence = Presence.create({
  initialState: () => ({ online: [] }),
  reducer: {
    Changed: ({ userId, online }, { state }) => ({
      ...state,
      online: online ? [...state.online, userId] : state.online.filter((id) => id !== userId),
    }),
    PropsChanged: ({ previous }, { state, props }) =>
      previous.roomId === props.roomId ? state : { ...state, online: [] },
  },
  subscriptions: ({ props }) => ({
    [`presence:${props.roomId}`]: Subscription.effect((dispatch) =>
      Effect.gen(function* () {
        const api = yield* PresenceApi;
        yield* Stream.runForEach(api.events(props.roomId), (event) => dispatch(Changed.make(event)));
      }),
    ),
  }),
  render: ({ state }) => …,
});
```

`Mounted` and `Unmounted` handlers are gone from that feature. A room switch is
a key change, and the runtime does the rest.

## The value — one leaf, the same leaf

```ts
type Subscription<A, R = never> = {
  readonly _tag: "Effect";
  readonly effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>;
};

type Subscriptions<A, R = never> = Readonly<Record<string, Subscription<A, R>>>;

Subscription.effect: <A = never, R = never>(
  effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>,
) => Subscription<A, R>;
```

**The leaf is `Command.effect`'s leaf.** Everything Effect can express is left
to Effect: `Stream.runForEach` for a stream, `Effect.acquireRelease` then
`Effect.never` for an `addEventListener`, `Effect.retry(Schedule.exponential(…))`
for reconnect. The error channel is `never` on the same terms as a command's —
a subscription that can fail types its recovery inside the effect, and what
still dies is a defect (see Failure).

**One variant.** `Keyed` is the record key; `Batch` is a second entry in the
record; `None` is an absent entry; `Cancel` is not declaring it. Nothing a
second variant would say is left to say. `_tag` stays so devtools can summarise
the value the way `CommandSummary` does, and so a variant is additive.

**It emits through `Dispatcher<Emit<A, O>>`** — actions and outputs, exactly
as a command's leaf. A presence feed that announces `MemberLeft` outward needs
no mirror action.

**`R` is real.** `Subscription.effect` carries `R` out of the effect it is
handed, and `create` unions it into the feature's `R`, so a service a
subscription needs is still a compile error at `component`. Under a mount the
fiber is forked inside the mount's `Effect.provide(layer)` and `Effect.scoped`,
so the feature layer is ambient and `Effect.addFinalizer` lands on the mount
scope, both exactly as for a command. Under `run`, `options.layer`.

**The key is a string, and the key is the whole identity.** The hook returns a
record; own keys only (`Object.keys`, the same prototype rule every tag-keyed
lookup in `lib.ts` follows). Two `Subscription` values under one key across
two folds are the same subscription; nothing else about them is compared.
Anything the subscription depends on belongs in the key —
`` `presence:${props.roomId}` ``, not `presence`. Elm compares the whole `Sub`
value structurally and can, because Elm has no closures; a JS closure is
opaque, so the key carries what Elm's value would. See The diff for what
happens when it does not.

**A subscription whose effect completes is done, not restarted.** Its key stays
in the running book as `done`, and the diff treats a declared key that is done
as unchanged. It starts again only when its key leaves the declared set and
returns. A finite source is therefore legal, which is what makes a test's
`Stream.fromArray` stub legal.

## The hook — `subscriptions` on `create`

```ts
Feature.create({
  initialState,
  reducer,
  render,
  subscriptions?: (snapshot: Snapshot<Props, State, H>) => Subscriptions<Emit<A, O>, R>,
});

Definition.subscriptions(fn); // identity typer, beside `reducer` and `render`
```

**On `create`, beside `reducer` and `render`, not inside the reducer.** A
subscription is not an action and its hook does not return a `Next`; putting
it under a reducer key would break the one contract every handler has. `define`
is untouched: it declares vocabularies and schemas, and a subscriptions hook is
behaviour, which is `create`'s half.

**Snapshot form, not positional.** `Snapshot<Props, State, H>` is already
"everything readable at a moment" and is what every handler receives; a hook
keyed on a hook value (`snapshot.hooks.online`) reads the same object.

**Optional, and absent means nothing runs and nothing is paid.** A feature that
declares no hook never evaluates a diff: the store checks `subscriptions ===
undefined` once and skips every site below.

**Pure and cheap, documented not enforced.** It is called after every fold that
moved state or ambient inputs. A throwing hook is a defect on the store's
rule, `from` being the tag of the action whose fold triggered the diff
(`"Mounted"` from `start()`), and the previous declared set stands.

**`Feature` gains `subscriptions(snapshot)`**, the pure read beside `reduce`:
what this state declares, as a record, `{}` when the feature has no hook.
"Which keys does this state want" is then a test with no runtime, on the same
terms as `reduce` for a command.

## The diff

**Once per drain, not once per action.** The declared set is evaluated at the
end of `fold`'s drain loop when state moved, from `sync` when props or hooks
moved (a `PropsChanged` handler may return the same state and still change the
key), and from `start()` unconditionally after the `Mounted` fold. Intermediate
states inside one drain never get subscriptions: a subscription is a function
of settled state, and starting a fiber for a state that exists for zero ticks
is churn a devtools log would have to explain.

**Only while a mount is live.** Before `start()`: nothing, whatever `sync` has
folded. After `stop()`: nothing. A mount whose fiber died (a layer that failed
to build) took its subscriptions with it, since they were children of its
scope; the store clears the declared set beside `dead = true`, and a re-arm
through `start()` evaluates from scratch.

**Keys only.** Start `declared ∖ running`, stop `running ∖ declared`, keep the
intersection, where `running` includes keys whose fiber is `done` or `died`.
The result is one queue item, `{ _tag: "Subscriptions", stop, start }`, handed
to the mount fiber — the fork needs the mount's scope and services, so it
cannot happen in the fold — and interpreted stops first, then starts, in the
record's own key order.

**An unchanged key with a different closure keeps the old fiber.** The hook
returned `presence` on both sides of a room switch; the runtime sees one
unchanged key and the fiber built for the old room keeps running. This is the
contract, stated once here and loudly in the docs: the runtime cannot see
inside a closure, so the key must say what the closure captured. Rejected
alternatives are under Deferred decisions.

**Sync-driven folds run the diff from the layout effect.** `store.sync` is
called once per committed render, from a `useLayoutEffect` in `component`,
never from the render body; it folds `PropsChanged` / `HookChanged`, offers
their commands, and diffs once after both. The fork itself happens on the
mount fiber. A render React discards never reaches `sync`, so a key the
discarded render would have declared is never started and the committed key
is never interrupted: a suspended transition into a new room starts that
room's feed on the commit that shows it. The design is recorded in
`lib.specs.md` under Deferred decisions, `store.sync` folding during render,
executed.

## Quiescence — what `Feature.run` waits for

`run` resolves at **command** quiescence: `book.inFlight === 0` and nothing
queued, exactly the rule from before the split. Subscription fibers live in their own book and
count for nothing. A never-completing subscription does not hold `run` open;
a never-completing _command_ does, and that is the definition of a command
rather than a limitation — work that finishes.

At resolve, `run` records the declared keys in a new result field,
`subscriptions: ReadonlyArray<string>`, then interrupts every subscription
fiber it started, so the report is stable and nothing leaks past the returned
Effect.

What a subscription dispatches folds like what a command dispatches: actions
land in `emitted`, outputs in `outputs`, a death in `defects` with `from` set
to the key.

**The test protocol.** Stub the source through the layer with a stream that
emits synchronously — `Stream.fromArray`, `Stream.make`. `run` keeps its
existing rule of yielding once after each action so the fibers that action
forked run to their first suspension, and the subscriptions that action's fold
declared are started on the same terms, so a synchronous stub's elements are
folded before the next action is reduced and before `run` resolves. A stub
that emits asynchronously — `Stream.tick`, a delayed effect — is **not**
awaited: `run` resolves at command quiescence and the late emission is lost
with the interrupt. Test an asynchronous source by seeding its actions, which
tests the fold, or drive `createFeatureStore` by hand (`start`, `dispatch`,
sleep, `stop`) as `lib.test.ts` does for every timing claim today.

## Teardown — what unmount owes work in flight

`stop()` now does, in order:

1. Empties the declared set synchronously and reports
   `SubscriptionStopped { reason: "Unmounted" }` for every running key.
2. Reduces `Unmounted`, queues the teardown, reports the `Unmounted` transition
   and the teardown `Command` event — unchanged.

The mount fiber, on the teardown item and under the existing whole-teardown
`timeoutOption("5 seconds")`:

3. `Fiber.interruptAll` over the subscription fibers, awaited.
4. Interprets the `Unmounted` command, services alive.
5. Drains until `inFlight === 0` and the queue is empty. **In-flight commands
   are not interrupted.** They finish, and what they emit folds.
6. Returns; the scope closes; the feature layer is released.

Overrun of the 5s bound raises the existing defect (`from: "Unmounted"`,
"did not settle within 5s; scope closed anyway"), the loop returns, and
structured concurrency interrupts whatever is left — a slow command, a hung
finalizer.

This is the answer to `lib.specs.md` open work #2: **commands finish,
subscriptions stop, the `Unmounted` command runs regardless and may `cancel`
what it does not want to wait for, the whole bounded at 5s, an overrun is one
defect, and the scope closes anyway.** "Flush-on-exit belongs in `Unmounted`"
stops being a rule, because flushing is now the default; kill-on-exit is the
opt-in, `Unmounted: (_, { state }) => [state, Command.cancel("slow")]`.

`Unmounted`'s command runs before the drain, not after it, for two reasons: a
`Cancel` it carries has to reach the in-flight fibers, and the feature's last
word must not wait on foreign work — a slow request would otherwise starve the
flush it was written for. What this cannot express is an `Unmounted` command
that wants to run _after_ in-flight work; see Deferred decisions.

A command that overruns is a defect, not a silent drop. At unmount, work that
takes more than five seconds is either a subscription in disguise or too slow
to be a command, and both deserve an `Error`.

## Failure

A subscription that dies — a non-interrupt failure of its fiber — is reported
through `raiseDefect(error, key, { _tag: "Subscription", key })`: one `Defect`
event, then the `Error` fold on the store's rule when the feature handles it,
then `SubscriptionStopped { reason: "Died" }`. Under `run` it lands in
`defects` as `{ from: key, error, handled }`. Interruption is not a defect, as
for a command.

**The runtime does not restart it.** The key stays in the running book as
`died`, so the next diff sees a still-declared key as unchanged and leaves it
dead. Restarting is the feature's decision, expressed through the key: bump an
attempt counter in the `Error` handler and put it in the key
(`` `presence:${roomId}:${state.attempt}` ``), or stop declaring the key and
declare it again on Retry. Reconnect with backoff belongs _inside_ the effect
(`Effect.retry(Schedule.exponential("1 second"))`) on the "concurrency is
userland" rule `lib.specs.md` already applies to commands. An automatic
restart was rejected because a subscription that fails on its first tick would
flood the `Error` handler — the spin the re-arm work in `lib.specs.md` open
work #1 was written to avoid.

`from` is the key, verbatim. Accepted: `from` on the `Error` action is now two
namespaces in one string, and a key named after a lifecycle tag would be
ambiguous there. The devtools cause is not ambiguous; see Deferred decisions
for the discriminator that was not added.

## Acceptance Criteria

Every box holds. Each line names its harness — `run`,
`createFeatureStore` driven by hand (`subscriptions.test.ts`), tstyche, or a
browser test in `subscriptions.browser.test.tsx` by title. The four browser
cases under Browser coverage are green under
`vp -C packages/react test --project browser`.

### The value

- [x] `Subscription.effect(fn)` returns `{ _tag: "Effect", effect: fn }`; the value is `Pipeable` and piping preserves `A` and `R`. (`lib.test.ts`)
- [x] `Subscription` has exactly one variant; there is no `keyed`, `batch`, `cancel`, `restart`, `none` or `stream` constructor. (tstyche)
- [x] The effect receives a `Dispatcher<Emit<A, O>>`: an action it dispatches folds and an output it dispatches leaves through `on<Tag>` (store) or lands in `outputs` (`run`), on the same terms as a command's leaf. (`run`, `createFeatureStore`)
- [x] A subscription whose effect completes is not restarted while its key stays declared: a `Stream.fromArray` stub emits its elements once across three folds that keep the key. (`run`)
- [x] A completed subscription starts again when its key leaves the declared set and returns. (`run`)
- [x] `feature.subscriptions(snapshot)` returns what the hook returns for that snapshot, and `{}` for a feature that declared no hook, without a runtime. (`lib.test.ts`)

### The hook

- [x] `create` accepts an optional `subscriptions` beside `initialState`, `reducer` and `render`; `Definition.subscriptions(fn)` is an identity typer on the same terms as `Definition.reducer`. (`lib.test.ts`, tstyche)
- [x] With no hook, the store never evaluates a diff: a feature with no `subscriptions` behaves byte-for-byte as before the split under `start`, `dispatch`, `sync` and `stop`, and the existing suite passes unchanged. (`lib.test.ts`)
- [x] The hook is handed the settled `Snapshot` — `state` after the whole drain, current `props` and `hooks`. (`createFeatureStore`)
- [x] A throwing hook raises one defect with `from` = the tag of the action whose fold triggered the diff, folds `Error` when handled, and leaves the previous declared set running. (`createFeatureStore`)

### The diff

- [x] After `start()`, the set declared for the post-`Mounted` snapshot is started, whether or not `Mounted` moved state. (`createFeatureStore`)
- [x] A dispatch whose fold moves state to a snapshot declaring a new key starts that key and only that key. (`createFeatureStore`)
- [x] A fold whose snapshot no longer declares a running key stops it: the fiber is interrupted, its finalizer runs, and `SubscriptionStopped { reason: "Undeclared" }` is reported. (`createFeatureStore`)
- [x] A key present before and after a fold is untouched: the fiber's identity is the same and no event is reported for it. (`createFeatureStore`)
- [x] One drain of three queued actions evaluates the hook once, against the final state, and a key declared only by an intermediate state never starts. (`createFeatureStore`)
- [x] A dispatch whose fold returns the same state reference does not evaluate the hook. (`createFeatureStore`)
- [x] `sync` with changed props evaluates the hook even when the `PropsChanged` handler returned the same state, so a key built from props restarts under the new key. (`createFeatureStore`; under React, `subscriptions.browser.test.tsx` "a room switch restarts under the new key, with no `Mounted` or `Unmounted` involved")
- [x] Before `start()`, folds from `sync` start nothing; after `stop()`, a dispatch starts nothing. (`createFeatureStore`)
- [x] An unchanged key across a props change keeps the old fiber, closure and all — pinned deliberately, as the contract. (`createFeatureStore`)
- [x] Stops are interpreted before starts within one diff. (`createFeatureStore`, observed through `Ref` logging order)
- [x] After a layer failure the declared set is cleared; a dispatch that re-arms the mount starts the declared keys afresh under the rebuilt layer. (`createFeatureStore`)

### `Feature.run`

- [x] `run` resolves with a subscription in flight whose effect is `Effect.never`. This is the inversion of "does not terminate while a never-completing command is in flight": the subject became `Subscription.effect(() => Effect.never)` and asserts `Option.isSome`; the command form stays as the control and still asserts `Option.none()`. (`run`, `lib.test.ts`)
- [x] `run` evaluates the hook after each reduced action and starts and stops on the same diff rules as the store. (`run`)
- [x] Actions a subscription dispatches land in `emitted`, outputs in `outputs`; seeded actions still do not. (`run`)
- [x] A synchronous stub (`Stream.fromArray` of two elements) declared by `Mounted`'s fold has both elements in `emitted` and folded into `state` when `run([Mounted])` resolves. Probed against `effect@4.0.0-rc.112`: `Stream.runForEach(Stream.fromArray(…))` emits every element before its first suspension, so one `Effect.yieldNow` after the fork sees all of them. (`run`)
- [x] The result carries `subscriptions: ReadonlyArray<string>` — the keys declared at resolve, in record key order — and every subscription fiber is interrupted before the Effect resolves; a finalizer inside one has run by the time the caller reads the result. (`run`)
- [x] A dying subscription is recorded in `defects` with `from` = key and `handled` on the store's rule, and `Error` is folded before `run` resolves. (`run`)
- [x] Seeding `Unmounted` empties the declared set: every running subscription is interrupted and `subscriptions` is `[]`. (`run`)

### Store and teardown

- [x] `stop()` reports `SubscriptionStopped { reason: "Unmounted" }` for each running key **before** the `Unmounted` transition. (`createFeatureStore` + recorder)
- [x] Teardown interrupts subscription fibers before interpreting the `Unmounted` command, and awaits their finalizers. (`createFeatureStore`)
- [x] `start(); dispatch(Go); stop()` with a 50ms command from `Go` **runs the command to completion** and folds what it emits — the inverse of the old "In-flight work is interrupted by unmount" assertion, which was rewritten rather than deleted. (`createFeatureStore`; under React, `subscriptions.browser.test.tsx` "unmount stops the subscription and lets a pending command finish")
- [x] `Unmounted: () => [state, Command.cancel("Go")]` interrupts that in-flight command at teardown, and nothing it would have emitted folds. (`createFeatureStore`)
- [x] A command still running at the 5s bound raises exactly one defect with `from: "Unmounted"`, and the scope closes — its finalizer runs. (`createFeatureStore`, fake clock)
- [x] The `Unmounted` command runs even when an in-flight command outlasts the bound; both are under one budget. (`createFeatureStore`, fake clock)
- [x] A subscription whose finalizer hangs is caught by the same bound and reported as the same defect. (`createFeatureStore`, fake clock)
- [x] `stop(); start()` on one store (StrictMode's shape) starts every declared key exactly once on the second mount, with the first mount's fibers interrupted. (`createFeatureStore`; under real StrictMode, `subscriptions.browser.test.tsx` "StrictMode's double mount starts exactly one subscription per key on the surviving mount")

### Failure

- [x] A subscription that dies reports one `Defect` (`from` = key, `handled` on the store's rule), folds `Error` when handled with `from` = key, then reports `SubscriptionStopped { reason: "Died" }`. (`createFeatureStore` + recorder)
- [x] A died key still declared on the next fold is not restarted. (`createFeatureStore`)
- [x] A died key that leaves the declared set and returns restarts. (`createFeatureStore`)
- [x] A subscription that dies before the mount fiber's booking statement runs is still reported. `forkChild` schedules the body on the dispatcher, and the scheduler's op budget can yield the mount fiber between the fork and its booking; the book books the fiber first and then attaches its exit observer, and an observer attached after the fiber has exited fires at attach (`lib.probe.test.ts` P2), so the death is reported against a booked key. Holds for the store and for `run`, across a 500- and 1000-key declaration. (`subscriptions.stress.test.ts`)
- [x] `Command.cancel(key)` for a running subscription's key interrupts nothing: the subscription keeps emitting. (`createFeatureStore`)
- [x] A command group and a subscription key with the same name coexist: `cancel(name)` interrupts the command and leaves the subscription running. (`createFeatureStore`)

### Devtools

- [x] `SubscriptionStarted { key }` is reported at the diff, before the fiber runs, with the cause of the fold that produced the set. (`createFeatureStore` + recorder)
- [x] `SubscriptionStopped { key, reason }` has `reason` `"Undeclared"` at a diff, `"Unmounted"` at `stop()`, `"Completed"` when the effect returns and `"Died"` after its `Defect`. (`createFeatureStore` + recorder)
- [x] A transition for an action a subscription dispatched carries `cause: { _tag: "Subscription", key }`. (`createFeatureStore` + recorder)
- [x] Every new event is JSON round-trippable, and the `Json` type test covers the fifth cause. (`devtools.test.ts`, tstyche)
- [x] Console lines for the two events are printed as specified in `devtools.specs.md`, against an injected console. (`devtools.test.ts`)
- [x] With no sink installed, a diff allocates no event — by construction, on the same `const target = devtools(); if (target !== undefined)` shape as every existing site.

### Type-level (TSTyche) — `src/__type-tests__/subscriptions.tst.ts`

- [x] `Subscription<Narrow>` is assignable to `Subscription<Wide>`; `Subscription.effect(() => Effect.void)` is `Subscription<never, never>` and fits every slot.
- [x] Inside the hook, `dispatch` is typed by the feature's vocabulary from the contextual type `create` supplies: an undeclared tag and a declared tag with the wrong payload are compile errors; an output tag is accepted.
- [x] Written standalone, `Subscription.effect` infers `A = never` and needs the type argument — the same rule and the same `@ts-expect-error` pinning as `Command.effect`.
- [x] `Subscription.effect` carries `R`; a hook whose subscription needs `PresenceApi` makes `component(feature)` under a root without it a compile error, and `component(feature, { layer })` satisfying it compiles.
- [x] `R` is inferred through a context-sensitive leaf (`(dispatch) => …` reading a service) with no type argument, at both `Definition.subscriptions` and `create`: the hook's type carries `PresenceApi` and `component` under a root without it is a compile error.
- [x] A `Command` as a record value in the hook is a compile error, and a `Subscription` returned from a reducer handler is a compile error.
- [x] The hook's parameter is `Snapshot<Props, State, H>` with `children` as declared and `hooks` as `H`.
- [x] `run`'s result type has `subscriptions: ReadonlyArray<string>`; `Feature.subscriptions` is `(snapshot) => Subscriptions<…>`.
- [x] `subscriptions` is absent from `Reducer`'s key set: writing it as a handler is a compile error.

## Technical Requirements

As landed. Five points deviate from the first draft of this section, all
deliberate; each is marked **deviation**.

- `Subscription` and `Subscriptions` are declared in `lib.ts` beside `Command`; devtools imports the type only, keeping the one runtime edge `lib → devtools`.
- **Nominal, not structural.** The one variant is structurally identical to
  `Command`'s `Effect` variant, so a `unique symbol`-keyed phantom field
  (`[subscription]: true` on `Subscription`, `[subscription]?: never` on
  `Command`) keeps the two apart in both directions: a `Subscription` cannot
  sit in a `Next` tuple and a `Command` cannot be a record value.
- **`Subscriptions` admits `undefined` as a record value — deviation.** The
  type is `Readonly<Record<string, Subscription<A, R> | undefined>>` and
  `undefined` means "not declared". TypeScript normalises
  `cond ? {} : { feed }` to `{ feed?: Subscription | undefined }`, which is
  not assignable to a record whose values are all `Subscription`, and that
  is the natural way to write an optional key. Admitting `undefined` makes
  that form and `{ feed: cond ? sub : undefined }` both type-check and mean
  the same thing. `declaredKeys` filters `undefined` values out wherever
  keys are read, so the runtime never sees them.
- **Two books per mount.** The fiber book stays as it is. Beside it,
  `subscriptions: Map<string, Fiber<void>>` per `Mount` (and per `run`
  invocation) — **deviation:** no `status` field. A fiber that completed or
  died stays booked under its key until the key leaves the declared set, and
  that is all "done" and "died" ever meant to the diff: a booked key is
  unchanged. `inFlight` never counts a subscription fiber.
- **The declared set** is `ReadonlySet<string>` on the store, cleared by
  `stop()` and by the mount's `catchCause` beside `dead = true`, and replaced
  by each evaluation. The diff is computed against it, not against the
  mount's book: two back-to-back dispatches fold before the mount fiber has
  interpreted the first's `Subscriptions` item, so the book is stale at the
  second diff (ex 33).
- **`Work` gains one variant**, `{ _tag: "Subscriptions"; stop: ReadonlyArray<string>; start: ReadonlyArray<readonly [string, Subscription]> }`.
  The loop interprets it as `Fiber.interruptAll` over the stopped entries
  (awaited, so a fiber cannot emit after its key is gone), then one fork per
  start.
- **`subscriptionBook(deps)`**, one module beside `commandInterpreter`, owns
  the fiber map for the store and for `run`; the two differ only in its deps,
  where an emission goes (`fold` with `{ _tag: "Subscription", key }`, or the
  `run` queue) and what a death does. `fork(key, subscription)` mirrors
  `forkLeaf` minus the group booking: `Effect.forkChild` of
  `Effect.suspend(() => subscription.effect(…))`, then the booking, then
  `fiber.addObserver`. The observer fires synchronously inside a pre-start
  interrupt, at attach when the fiber has already exited, and once after a
  deferred interrupt (`lib.probe.test.ts`), so a death between the fork and
  the booking is reported against a booked key and nothing counts a
  subscription as in flight. The observer reports only while the book still
  holds this fiber under the key, so a fiber that died as its key was being
  stopped does not report after its `Undeclared`/`Unmounted`; then
  `raiseDefect` on a non-interrupt failure and `SubscriptionStopped` with
  `Died` or `Completed`. `diffDeclared(previous, next)` is the pure diff both
  reconciles call.
- **`reconcile(from: string, cause: DevtoolsCause)`** on the store: returns
  early when the feature has no hook; when there is no live mount it returns
  too, except for the re-arm case below; otherwise evaluates
  `feature.subscriptions(snapshot())` inside `try/catch` (a throw goes to
  `raiseDefect(error, from, cause)` and returns, the previous set standing),
  computes the key diff against the declared set, reports
  `SubscriptionStarted` / `SubscriptionStopped(Undeclared)` synchronously,
  offers one `Subscriptions` item to the mount queue, and replaces the set.
  Three call sites: the `finally` of `fold` when `moved || dirty` and not
  `syncing` (outside the `folding` guard, since the hook is pure and offers
  rather than folds); `sync` after its folds when props or hooks moved;
  `start()` after `fold({ _tag: "Mounted" })`, through the `dirty` flag —
  the re-arm path calls `start()` from inside a fold, where `Mounted` is
  queued rather than folded, so the flag outlives the call and the outer
  drain reconciles whether or not `Mounted` moved state.
- **A dead mount re-arms on a dispatch-caused fold that declares a key —
  deviation.** `offer` re-arms a dead mount only when a `Dispatch`-caused
  fold produced a command (`lib.specs.md` open work #1). A fold whose
  snapshot declares at least one subscription but returns no command never
  reaches `offer`, so `reconcile` carries the same rule: dead, inactive,
  `cause._tag === "Dispatch"` and `declares()` non-empty → `start()`, which
  folds `Mounted` and reconciles from scratch against the rebuilt layer.
  Lifecycle-, command- and defect-caused folds never re-arm, for `offer`'s
  reasons. A throwing hook in `declares()` is a defect on the same rule as at
  a diff.
- **`stop()`** clears the declared set and reports `SubscriptionStopped(Unmounted)`
  per running key **before** reducing `Unmounted`, so the console logger's
  elapsed eviction on the `Unmounted` transition is not undone.
- **Teardown** is: interrupt subscription fibers (awaited) → interpret the
  `Unmounted` command → drain until `inFlight === 0` and the queue is empty,
  dropping any `Subscriptions` item it meets. The
  `Fiber.interruptAll(allFibers(cells.book))` line is gone; nothing else in
  the loop moved. All of it under the existing `timeoutOption("5 seconds")`,
  so a subscription whose finalizer hangs is caught by the same bound.
- **`run`**: a subscription book beside `book`; `reconcile` after each reduced
  action (an `Unmounted` entry empties the set instead), on the same
  `Effect.yieldNow` the commands already get; the drain condition unchanged;
  at exit, read the declared keys, `Fiber.interruptAll` over the subscription
  fibers (awaited), then return `{ state, emitted, outputs, defects,
subscriptions }`. Emission entries carry `origin: "subscription"` and are
  pushed to `emitted` like `"command"` entries; a subscription's death is
  `raise(error, key)` through the same `onExit`.
- **Types — deviation on the inference path.** `create<U, SR = never>` takes
  `subscriptions?: SubscriptionsHook<Props, State, H, Emit<A, O>, SR>` and
  returns `Feature<…, ServicesOf<U> | SR>`: `R` is inferred straight from
  the hook's return record, and the parameter's type is what gives each
  leaf's `dispatch` its contextual type. The drafted
  `S extends SubscriptionsHook<…> | undefined` generic with a
  `SubscriptionServicesOf<S>` helper does not work: a generic `S` is never
  inferred through the contextually-typed arrow, so `dispatch` inside the
  hook fell to `never`. There is no `SubscriptionServicesOf`. The same two
  consequences as for `Command.effect` apply: standalone needs the type
  argument, and `.pipe` severs it. `Exhaustive` gained an allowed-key set
  (`A["_tag"] | LifecycleTag`), so `subscriptions` under `reducer` is an
  error string on that key.
- **Devtools.** Two event members and a fifth cause; see `devtools.specs.md`.
- Every emission site keeps the `const target = devtools(); if (target !== undefined)` shape.

### Harness probes worth knowing

Three things the exercises hit that the next pass on this code will hit too:

- **A `TestClock` sleep inside an interrupted fiber's finalizer returns at
  once** (`effect@4.0.0-rc.112`) rather than waiting for `adjust`. A test
  that wants a finalizer to hang under the teardown bound uses
  `Effect.never`, not a long `Effect.sleep` (ex 30).
- **tstyche substring-matches `@ts-expect-error` text.** The directive's text
  is matched as a substring of the diagnostic, so it names a stable fragment
  (`is not assignable to type 'Subscription`), not the whole message.
- **An optional property's union target blocks arrow-body elaboration.**
  `subscriptions` is optional, so its target type is a union with
  `undefined`, and TypeScript does not elaborate an arrow body against a
  union target: a `Command` as a record value is reported on the hook, not
  on the value. The message still names the hook's type, which is what the
  directive matches (`subscriptions.tst.ts`).

## Expected Behavior & Edge Cases

- **Stops precede starts in one diff**, so a key that changes on a props flip
  releases the old socket before opening the new one — the ordering the
  `restart` sugar guaranteed by hand.
- **Emissions after an undeclare cannot fold.** `Fiber.interruptAll` on the
  stopped entries is awaited before the starts are forked and before the loop
  takes the next item, so a stopped subscription's last `dispatch` cannot land
  after its `SubscriptionStopped`. A hung finalizer stalls the mount loop, on
  the same terms as a `Cancel`'s finalizer today.
- **A command finishing during teardown folds into the store.** State is
  store-level; only command routing is per mount. Under a normal unmount that
  state has nowhere to go. Under StrictMode's `stop(); start()` the store is
  the remounted store, so a `Mounted` command from the first mount that
  resolves during the second mount's life folds there — and the second mount's
  own `Mounted` command folds the same result again. The rule "`Mounted` is
  idempotent" now extends to what its command folds: `Task.resolved(value)`
  replaces and is fine; an append is not. The old unmount sweep masked this. A feature
  that cannot make the fold idempotent cancels in `Unmounted`.
- **Teardown holds the feature layer open** for as long as an in-flight command
  takes, up to the bound, where before the split it closed at once. A page unmounting many
  features with slow requests in flight keeps their layers alive for that long.
- **A subscription started by a discarded render** is stopped by the committed
  render's diff if its key is not declared there. The fiber may have opened a
  connection in between; that cost is bounded by the keys the discarded render
  declared and is the price of `sync` folding in render.
- **`Mounted` fires once per effect cycle**, and so does the initial
  reconcile: twice under StrictMode, with the first mount's subscriptions
  interrupted by the first `stop()`.
- **A subscription that emits synchronously inside its own fork** — before
  `forkChild` returns — is handled by the re-entrancy guard the fold already
  has: the emission lands in `pending` and folds after the current drain.
- **`HookChanged` reaches the hook**: a key built from `snapshot.hooks` restarts
  when the hook value moves, since `sync` reconciles on hooks as on props.
- **A key that is a lifecycle tag or an action tag** is legal and collides
  with nothing at runtime; only `Error.from` becomes ambiguous for it.

- A key whose fiber died and is later undeclared reports a second
  `SubscriptionStopped`, reason `Undeclared`, after the `Died` one. The
  events describe the declared set, and the key did leave it; a reader
  counting live keys as started minus stopped has to skip `Died`. Asserted in
  `subscriptions.stress.test.ts`.

## Known limitations

- **`run` does not await asynchronous subscription emissions.** A stub that
  emits on a timer loses its emission at resolve. The synchronous-stub recipe
  rests on "emits before the first suspension", which is a property of the
  installed scheduler pinned by a test, not a contract this runtime can make.
  The old command form waited on the stream's completion robustly, at the
  price of never resolving for an endless one.
- **A stale closure under an unchanged key is undetectable.** The runtime
  cannot compare closures and does not try. The docs own this rule; devtools
  can only show that no restart happened.
- **Two ways to run a long-lived effect remain.** `Command.effect` draining a
  stream compiles and runs exactly as before. Nothing but the docs steers a
  reader to the subscription.
- **`Error.from` mixes two namespaces**: action tags for commands and handlers,
  subscription keys for subscriptions. The devtools cause tells them apart;
  the action does not.
- **A subscription cannot be cancelled by a handler**, by design (see Deferred
  decisions), so a one-off "drop this feed now" without a state change has no
  spelling.

## Open work

None. The scheduler probe under `Feature.run`'s criteria was done and is
recorded on its box.

## Deferred decisions

### `Subscription.stream(stream)` — deferred

Sugar for `Subscription.effect((dispatch) => Stream.runForEach(stream, dispatch))`.
`Command.stream` was removed for exactly this one-line reason, and a second
constructor is a second thing devtools and the type tests have to know.
Revisit if the docs show the `runForEach` line is the noise in every example.

### Structural or reference key equality — rejected

A key that is a value (`{ room: roomId }`) compared by `Equal.equals`, or the
`Subscription` compared by reference. Reference identity restarts everything
on every fold, because a pure hook builds fresh values each call. A structural
key needs an equivalence and a hash for a value the library does not own, and
`` `presence:${roomId}` `` says the same thing in a string the user already has.
One consequence accepted with it: the closure-under-unchanged-key footgun.

### Positional hook `(state, props, hooks)` — rejected

`Snapshot` is the library's word for "everything readable at a moment", and
handlers receive it as one object. A second calling convention for the same
three values would be the only one of its kind.

### Automatic restart on death — rejected

A subscription that dies is dead until its key changes. An automatic restart
needs a policy (immediately, with backoff, at most N times), which Effect
already has as `Effect.retry` inside the effect; and a subscription that fails
on its first tick would loop through the `Error` handler without anyone
asking, the spin the re-arm work avoided for layers.

### `Command.cancel` reaching a subscription key — rejected, final

Subscriptions are not in the fiber book. A `cancel` that reached one would
interrupt a fiber the next diff restarts, because the key is still declared:
a blip, not a stop. Two owners for one lifetime is the situation the split
exists to end. To stop a subscription, stop declaring it.

### Counting subscriptions as in flight until complete — rejected

Reintroduces the non-termination the split fixes. A middle ground — count
them until their first suspension — is not observable from outside Effect's
scheduler.

### A `settle` option on `run` — deferred

`run(actions, { settle: "1 second" })`, or awaiting until no subscription has
emitted for one yield. Both are heuristics dressed as an API. Drive
`createFeatureStore` by hand for timing claims, as the store's own tests do.

### `Unmounted` after in-flight work (`Command.await`) — deferred

The `Unmounted` command runs before the drain so its `Cancel` can reach
in-flight fibers. A flush that must run _after_ a pending save completes has
no spelling. `Command.await(name)` as a fifth variant would give it one and is
additive if a feature needs it.

### `Error.source` discriminator — deferred

`{ source: "command" | "handler" | "layer" | "teardown" | "subscription" }`
on the `Error` action would make `from` unambiguous. Additive; not until a
handler is found that needs to tell a key from a tag and cannot name the key.

### Hook as a reducer key — rejected

`Subscriptions: (snapshot) => record` inside the reducer object. Avoids a new
`create` entry at the cost of a handler that is not a handler: it takes no
payload and returns no `Next`, and `Exhaustive` would have to special-case it.

### Subscriptions declared beside state in `Next` — rejected

`[state, command, subscriptions]`. Every handler would have to restate the full
set or the runtime could not diff; Elm rejected the same shape for the same
reason.

## Browser coverage (`/e2e`)

Applicable, `src/subscriptions.browser.test.tsx`, all four green. The node
suite drives every diff and teardown rule through `createFeatureStore`; what
only a mount can show is the effect scheduling React owns:

- **A room switch restarts under the new key.** A parent flips `roomId` in
  `useState`; the old subscription's finalizer has run and the new key's fiber
  is emitting into the DOM on the render that carried the prop, with no
  `Mounted` or `Unmounted` involved.
- **Unmount stops the subscription and lets a pending command finish.** A
  feature with a subscription and a 50ms command in flight is unmounted; the
  recorder shows `SubscriptionStopped(Unmounted)` before the `Unmounted`
  transition, and the command's emission folds afterwards.
- **StrictMode double-mount starts exactly one subscription per key** on the
  surviving mount, with one `SubscriptionStopped(Unmounted)` for the
  simulated unmount.
- **A discarded render never declares its subscription** — a props flip
  inside a transition that suspends and is abandoned, on the pattern the
  latest-ref test already uses. The store never hears of the abandoned
  props: no `PropsChanged`, no start of the new key, no stop of the old one,
  and the way back folds nothing either. The feed in this case does not emit,
  so the log holds only what the diff did; the emitting variant is the
  stress case in `lib.stress.browser.test.tsx`.

The docs pages that build the presence example are executed by
`docs:check --run`; `docs/examples/presence-stream` is type-checked by
`vpr -r test:types`.
