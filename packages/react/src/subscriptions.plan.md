# subscriptions — implementation plan

Companion to `subscriptions.specs.md`. The spec says what; this says where and
with which APIs, without writing the code. The exercises in
`subscriptions.test.ts` and `__type-tests__/subscriptions.tst.ts` are red
until each step lands; every exercise carries a `HINT` naming its step.

Run one exercise:

    vp -C packages/react test src/subscriptions.test.ts -t "07"

Run the type half:

    vp -C packages/react run test:types

`vp check` stays red until the types exist. Expected — and the pre-commit
hook runs it, so commits on this branch need `--no-verify` until the
implementation lands.

## Already in place

- `subscriptions.test.ts` — 39 exercises in six parts. 37 red; 05 was
  trivially green until it also asserted the fiber ran, 27 is 26's control
  and must stay green.
- `__type-tests__/subscriptions.tst.ts` — eight tstyche exercises, all red.
- `lib.test.ts` — three tests rewritten in place per the spec: the
  never-completing `run` test has a subscription subject and a command
  control; "drains a command queued just before unmount" expects the command
  to finish; the never-completing-command teardown test cancels in
  `Unmounted`.
- `__type-tests__/core.tst.ts` — the string-keyed surface test expects
  `"reduce" | "run" | "subscriptions"`.

Two probes done against `effect@4.0.0-rc.112`, so the tests are written on
verified ground:

- `Stream.runForEach(Stream.fromArray([1, 2, 3]))` emits every element before
  its first suspension. One `Effect.yieldNow` after the fork sees all three.
- `ManagedRuntime.make(TestClock.layer())` drives `Effect.timeoutOption` in a
  forked fiber: `runtime.runPromise(TestClock.adjust("5 seconds"))` fires it.
- An unknown reducer key compiles today (`reducer: { Ping, subscriptions:
() => ({}) }` passes tstyche). The last type exercise needs a new guard.

## Step 1 — value and types (ex 01–04; tst 1, 3, 5–7, 9)

In `lib.ts`, beside `Command`:

- `Subscription<A, R>`: `Pipeable.Pipeable & { _tag: "Effect"; effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R> }`.
  One variant. Constructor object with one key, built with the existing
  `pipeable` helper. `index.ts` already re-exports `*`.
  Nominal, not structural: the one variant is structurally identical to
  `Command`'s `Effect` variant, so without a marker a `Subscription` slides
  into a `Next` tuple and the last type exercise in
  `subscriptions.tst.ts` cannot be red. A `unique symbol`-keyed phantom
  field on the type, assigned by the constructor, keeps the two apart in
  both directions.
- `Subscriptions<A, R>`: `Readonly<Record<string, Subscription<A, R>>>`.
- `SubscriptionsHook<Props, State, H, A, R>`:
  `(snapshot: Snapshot<Props, State, H>) => Subscriptions<A, R>`.
- `SubscriptionServicesOf<S>`: infer the hook's return record, map each value
  through `Subscription<any, infer R>`, index by `keyof`. Mind the
  distribution trap the `ServiceOf` comment describes — match with a tuple
  pattern, not a naked type parameter. `never` when `S` is `undefined`.
- `FeatureDefinition.create` gains a generic
  `S extends SubscriptionsHook<Props, State, H, Emit<A, O>, any> | undefined = undefined`,
  the parameter `subscriptions?: S`, and returns
  `Feature<…, ServicesOf<U> | SubscriptionServicesOf<S>>`. The constraint is
  what gives the leaf's `dispatch` its contextual type, the same trick
  `U extends Reducer<…>` plays for `Command.effect`. `Feature` is already
  `out R`.
- `FeatureDefinition.subscriptions(fn)`: identity, like `reducer` and
  `render`. Its only job is the parameter type.
- `Feature.subscriptions(snapshot)`: `parts.subscriptions ?? (() => EMPTY)`
  with one frozen `{}`.
- `run`'s result type gains `subscriptions: ReadonlyArray<string>`.
- For tst 9, extend `Exhaustive<U, State>` with an allowed-key set
  (`TagsOf<A> | LifecycleTag`): a key outside it maps to an error string, the
  same trick `state has no property …` already plays. Check the existing
  `Exhaustive` tests in `core.tst.ts` still pass.

## Step 2 — `Feature.run` (ex 05–12)

Inside `run`, beside `book`:

- A subscription book `Map<string, { fiber: Fiber.Fiber<void>; status: "running" | "done" | "died" }>`
  and `declared: ReadonlyArray<string>`. `inFlight` never counts a
  subscription fiber; the drain condition does not change. That is what
  makes 05 resolve.
- After each reduced action: `interpret` the command, reconcile, then the
  existing `Effect.yieldNow`. Reconcile evaluates
  `Object.keys(feature.subscriptions({ ...snapshot, state }))` in `try/catch`
  (a throw is a defect on the same rule as `onExit`, `from` = the action's
  tag), diffs against the previous `declared`, `Fiber.interruptAll` over the
  stopped fibers awaited and their entries deleted, then one fork per start.
  An `Unmounted` entry clears the set instead of evaluating (ex 12).
- Fork: `Effect.forkChild(Effect.asVoid(Effect.suspend(() => sub.effect((a) => Queue.offer(queue, { msg: a, origin: "subscription" })))))`.
  `origin: "subscription"` is treated like `"command"` for `emitted`;
  outputs route by tag through the existing `isOutput`.
- Watcher, as `forkLeaf`'s and for the same reason: `Fiber.await(fiber)`
  piped to a handler, then `Effect.forkChild`. On
  `Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)`: status
  `"died"`, push `{ from: key, error: Cause.squash(exit.cause), handled }`,
  and when handled queue `{ _tag: "Error", error, cause: Cause.die(error), from: key }`
  with `origin: "runtime"`. On success: `"done"`. Do not offer `settled`;
  nothing waits on a subscription.
- At exit: `subscriptions = declared`, `Fiber.interruptAll` over the book
  awaited (a finalizer inside one has run by the time the caller reads the
  result, ex 07), then return the five fields.

## Step 3 — the diff on the store (ex 13–23)

In `createFeatureStore`:

- `Work` gains `{ _tag: "Subscriptions"; stop: ReadonlyArray<string>; start: ReadonlyArray<readonly [string, Subscription<any, any>]> }`.
- `Mount` gains `subscriptions`, the same map shape as in `run`.
- Store-level `declared: Set<string>`.
- `reconcile(from: string, cause: DevtoolsCause)`: return early unless the
  feature has a hook and `mount !== undefined && active`. Evaluate the hook
  inside `try/catch`; a throw goes to `raiseDefect(error, from, cause)` and
  returns with the previous set standing (ex 22). Diff against `declared`,
  not against the mount's map: two back-to-back dispatches fold before the
  mount fiber has interpreted the first item, so the map is stale (ex 33).
  The map carries fibers and status; `declared` carries the key set. Report
  `SubscriptionStarted` and `SubscriptionStopped { reason: "Undeclared" }`
  under the `const target = devtools(); if (target !== undefined)` shape,
  `Queue.offerUnsafe` one item to `mount.queue`, replace `declared`.
- Three call sites. The `finally` of `fold`, after `folding = false`, when
  `moved && !syncing`, with the tag and cause of the last folded action.
  `sync`, once after its folds, when props or hooks moved (ex 18). `start()`,
  after `fold({ _tag: "Mounted" })` (ex 13). Trap: the re-arm path calls
  `start()` from inside a fold, so its `Mounted` is queued and the outer
  drain's `moved` decides — a `dirty` flag set by `start()` and honoured by
  the `finally` beside `moved` covers a `Mounted` that does not move state.
- Mount loop: `case "Subscriptions"` → `Fiber.interruptAll` over the stopped
  entries' fibers, awaited (so a stopped subscription cannot emit after its
  `Stopped`), delete the entries, then `forkSubscription` per start, in the
  record's order (ex 21).
- `forkSubscription(cells, key, sub)` mirrors `forkLeaf` without the
  `inFlight` increment and the group booking. Dispatch is
  `(a) => Effect.sync(() => fold(a, { _tag: "Subscription", key }, cells))`
  — routed to the mount that forked it, as `commandCause` does. Watcher on
  `Fiber.await(fiber)`, forked: interrupt → nothing; failure → status
  `"died"`, `raiseDefect(error, key, { _tag: "Subscription", key }, cells)`,
  then report `SubscriptionStopped { reason: "Died" }`; success → `"done"`,
  report `Completed`. Guard on the entry still being this fiber.
- The mount's `catchCause` clears `declared` beside `dead = true` (ex 23).

## Step 4 — teardown (ex 24–31)

- `stop()`: before `feature.reduce({ _tag: "Unmounted" })`, report
  `SubscriptionStopped { reason: "Unmounted" }` per key in `declared`, then
  clear it (ex 24). The console logger's elapsed eviction on the `Unmounted`
  transition is why this order matters.
- `teardown`: replace the `Fiber.interruptAll(allFibers(cells.book))` line
  with `Fiber.interruptAll` over the subscription map's fibers, awaited
  (ex 25). Then the `Unmounted` command, then the existing drain — which
  skips any `Subscriptions` item it meets, since nothing may start during
  teardown. Nothing else in the loop moves; the 50ms command simply finishes
  (ex 26) unless `Unmounted` cancels it (ex 27).
- The existing `Effect.timeoutOption("5 seconds")` covers ex 28–30 as is.
  Children of the mount fiber (`Effect.forkChild`) are interrupted when it
  ends, which is what makes "the scope closes anyway" true for an overrunning
  command's finalizer.

## Step 5 — failure (ex 32–34)

Covered by the watcher in step 3. Two books means `Cancel` reads only the
fiber book and never sees a subscription; nothing to write for ex 34 if they
stayed separate.

## Step 6 — devtools (ex 35–39; `devtools.tst.ts`)

In `devtools.ts`:

- `DevtoolsCause` gains `{ _tag: "Subscription"; key: string }`.
- `DevtoolsSubscriptionStarted { key }` and
  `DevtoolsSubscriptionStopped { key; reason: "Undeclared" | "Completed" | "Died" | "Unmounted" }`,
  both extending `DevtoolsEnvelope`, both in `DevtoolsEvent`.
- `DevtoolsColors.subscription?`, default `#FF9800`.
- In `onEvent`, after the predicate: branch on the two tags and print one
  `output.log` line — `▸ room#2  ⇉ <key> started` and
  `▸ room#2  ⇉ <key> stopped (<reason lower-cased>)` — `%c`-coloured, no
  group, no touch of the elapsed map. `skipUnchangedAmbient` and
  `skipUnchanged` already pass them (they test `_tag === "Transition"`).
- `devtools.tst.ts`: add both members and the fifth cause to the `Json`
  assertions and the `_tag` narrowing tests.

## After green

`vpr check` from the root. Then `/document`: the how-to
`subscribe-to-a-stream`, the `presence-stream` example, the Room example in
`reference/lifecycle.md`, the boxes in all three specs, and `lib.specs.md`'s
open work #2 and its quiescence limitation. The browser tests in the spec's
`/e2e` section are not written here; they need a mount and come after the
node suite is green.
