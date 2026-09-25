/**
 * Exercises for `subscriptions.specs.md`, Rustlings-style.
 *
 * Every test is red until you implement the piece it names. Work top to
 * bottom: each part builds on the one before, and the `HINT` above each test
 * names the spec section and the Effect APIs that get you there. Nothing here
 * is a full specification — the spec is; a test is the smallest thing that
 * distinguishes "done" from "not done".
 *
 * Run the whole file from the repo root:
 *
 *     vp -C packages/react test src/subscriptions.test.ts
 *
 * Run one exercise by its number:
 *
 *     vp -C packages/react test src/subscriptions.test.ts -t "07"
 *
 * Two existing tests in `lib.test.ts` are rewritten in place as the spec
 * demands (`Feature.run` with a never-completing subscription; a 50ms command
 * surviving unmount) — they go red with this file and green with it. When all
 * of this is green, run `vpr check` from the root: the type tests in
 * `src/__type-tests__/subscriptions.tst.ts` are the second half.
 */

import { Effect, Equivalence, Layer, ManagedRuntime, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";
import {
  createConsoleDevtools,
  createRecorder,
  devtoolsLayer,
  type DevtoolsConsole,
} from "./devtools";
import { tagged } from "./__fixtures__/devtools";
import { Action, Command, createFeatureStore, define, Subscription } from "./lib";

// ---------------------------------------------------------------------------
// Fixture
//
// One feature for the whole file. State: `n` moves on `Go`, `seen` collects
// `Tick` ids (what a subscription dispatches), `errors` counts `Error` folds.
// `Same` returns the same reference. `Kill` cancels the `work` group. `Out`
// is the one output. Props carry a `room`, for keys built from props.
// ---------------------------------------------------------------------------

const Props = Schema.Struct({ room: Schema.String });
const State = Schema.Struct({
  n: Schema.Number,
  seen: Schema.Array(Schema.String),
  errors: Schema.Number,
});
const Go = Action("Go", {});
const Same = Action("Same", {});
const Kill = Action("Kill", {});
const Tick = Action("Tick", { id: Schema.String });
const Out = Action.output("Out", { id: Schema.String });

type S = { readonly n: number; readonly seen: ReadonlyArray<string>; readonly errors: number };
type Snap = { readonly state: S; readonly props: { readonly room: string }; readonly hooks: {} };

const Def = define({
  props: Props,
  state: State,
  action: [Go, Same, Kill, Tick],
  output: [Out],
});

const baseReducer = {
  Go: (_a: unknown, { state }: Snap) => ({ ...state, n: state.n + 1 }),
  Same: (_a: unknown, { state }: Snap) => state,
  Kill: (_a: unknown, { state }: Snap) => [state, Command.cancel("work")],
  Tick: ({ id }: { readonly id: string }, { state }: Snap) => ({
    ...state,
    seen: [...state.seen, id],
  }),
  Error: (_a: unknown, { state }: Snap) => ({ ...state, errors: state.errors + 1 }),
};

const initialState = (): S => ({ n: 0, seen: [], errors: 0 });

/** `create` with a `subscriptions` hook. Loosely typed on purpose: the runtime is the subject here, the types are `subscriptions.tst.ts`'s. */
const makeFeature = (parts: {
  readonly reducer?: Record<string, any>;
  readonly subscriptions?: (snapshot: Snap) => Record<string, any>;
}) =>
  Def.create({
    initialState,
    reducer: { ...baseReducer, ...parts.reducer },
    render: () => null,
    ...(parts.subscriptions === undefined ? {} : { subscriptions: parts.subscriptions }),
  } as any) as any;

const equivalence = {
  props: Schema.toEquivalence(Props),
  hooks: Equivalence.Record(Equivalence.strictEqual<unknown>()),
} as any;

/**
 * A store with a recorder installed. `clock: true` puts a `TestClock` in the
 * runtime, so `Effect.sleep` inside commands and the teardown's 5s bound both
 * run on `runtime.runPromise(TestClock.adjust(…))` instead of wall time.
 *
 * Nothing is synced: call `store.sync(props, {})` yourself before `start()`
 * when a test needs `PropsChanged` later, exactly as a component's first
 * render does. (The first `sync` only records; the second compares.)
 */
const makeStore = (
  parts: Parameters<typeof makeFeature>[0] & {
    readonly clock?: boolean;
    readonly layer?: Layer.Layer<any, any, any>;
    readonly props?: { readonly room: string };
    readonly emit?: (output: { readonly _tag: string }) => void;
  } = {},
) => {
  const recorder = createRecorder();
  const defects: Array<unknown> = [];
  const outputs: Array<{ readonly _tag: string }> = [];
  const runtime = ManagedRuntime.make(
    parts.clock
      ? Layer.merge(devtoolsLayer(recorder.sink), TestClock.layer())
      : devtoolsLayer(recorder.sink),
  ) as unknown as ManagedRuntime.ManagedRuntime<any, any>;

  const store = createFeatureStore<{ readonly room: string }, S, any, {}>({
    feature: makeFeature(parts),
    props: parts.props ?? { room: "a" },
    equivalence,
    runtime,
    layer: parts.layer,
    emit: parts.emit ?? ((output) => void outputs.push(output)),
    defect: (error) => void defects.push(error),
    name: "room",
  });

  return { store, recorder, defects, outputs, runtime };
};

/** Wall-clock wait, independent of any `TestClock` in the runtime. */
const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A subscription that logs `key:start` when its body runs, then never
 * completes, and logs `key:stop` however it ends. A fiber interrupted before
 * the scheduler ran it logs neither, which is why tests `settle()` first.
 */
const logged = (log: Array<string>, key: string, body: Effect.Effect<unknown> = Effect.never) =>
  Subscription.effect(() =>
    Effect.sync(() => void log.push(`${key}:start`)).pipe(
      Effect.andThen(body),
      Effect.ensuring(Effect.sync(() => void log.push(`${key}:stop`))),
    ),
  );

/** A finite, synchronous source: one `Tick` per id, then done. */
const ticks = (...ids: ReadonlyArray<string>) =>
  Subscription.effect((dispatch: (a: any) => Effect.Effect<void>) =>
    Stream.runForEach(Stream.fromArray(ids.map((id) => ({ _tag: "Tick" as const, id }))), dispatch),
  );

const runWith = (
  feature: any,
  actions: ReadonlyArray<{ readonly _tag: string }>,
  props = { room: "a" },
): Promise<any> =>
  Effect.runPromise(feature.run(actions, { props, hooks: {}, layer: Layer.empty }));

// ---------------------------------------------------------------------------
// Part 1 — The value
// ---------------------------------------------------------------------------

describe("Part 1 — the value", () => {
  // HINT: spec "The value — one leaf, the same leaf". Declare `Subscription<A, R>`
  // beside `Command` in `lib.ts`, one variant, built with the same `pipeable`
  // helper `Command.effect` uses. Export `Subscription` from `lib.ts`; `index.ts`
  // already re-exports `*`.
  it('01 · `Subscription.effect(fn)` is `{ _tag: "Effect", effect: fn }`, and pipeable', () => {
    const effect = () => Effect.void;
    const sub = Subscription.effect(effect);

    expect(sub._tag).toBe("Effect");
    expect(sub.effect).toBe(effect);
    expect(sub.pipe((self: unknown) => self)).toBe(sub);
  });

  // HINT: "One variant." The constructor object has one own key.
  it("02 · there is exactly one constructor", () => {
    expect(Object.keys(Subscription)).toEqual(["effect"]);
  });

  // HINT: spec "`Feature` gains `subscriptions(snapshot)`". Add it to the
  // `Feature` interface beside `reduce`, and to what `create` returns. No hook
  // means a constant `{}` — the same frozen object each call is fine.
  it("03 · `feature.subscriptions(snapshot)` is the hook's record, or `{}` without a hook", () => {
    const snapshot: Snap = { state: initialState(), props: { room: "lobby" }, hooks: {} };

    const silent = makeFeature({});
    expect(silent.subscriptions(snapshot)).toEqual({});

    const sub = Subscription.effect(() => Effect.never);
    const declared = makeFeature({
      subscriptions: ({ props }) => ({ [`presence:${props.room}`]: sub }),
    });
    expect(declared.subscriptions(snapshot)).toEqual({ "presence:lobby": sub });
  });

  // HINT: `FeatureDefinition` gains `subscriptions`, an identity function at
  // runtime like `reducer` and `render`. Its job is to supply the types.
  it("04 · `Definition.subscriptions(fn)` is an identity typer", () => {
    const hook = () => ({});
    expect((Def as any).subscriptions(hook)).toBe(hook);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — `Feature.run`
// ---------------------------------------------------------------------------

describe("Part 2 — Feature.run", () => {
  // HINT: spec "Quiescence". `run` gets a second book for subscription fibers,
  // never counted in `inFlight`. After each reduced action (and its
  // `Effect.yieldNow`), evaluate the hook against the new state and diff keys
  // against that book: fork `declared ∖ running` with `Effect.forkChild`,
  // `Fiber.interruptAll` over `running ∖ declared`. The drain condition does
  // not change — that is what makes this resolve.
  it("05 · resolves with a never-completing subscription in flight", async () => {
    const log: Array<string> = [];
    const feature = makeFeature({ subscriptions: () => ({ forever: logged(log, "forever") }) });

    const result: Option.Option<unknown> = await Effect.runPromise(
      (
        feature.run([{ _tag: "Mounted" }], {
          props: { room: "a" },
          hooks: {},
          layer: Layer.empty,
        }) as Effect.Effect<unknown>
      ).pipe(Effect.timeoutOption("100 millis")),
    );

    // Both halves: the fiber ran (so this is not green because nothing
    // happened), and `run` still resolved.
    expect(log).toContain("forever:start");
    expect(Option.isSome(result)).toBe(true);
  });

  // HINT: spec "The test protocol". A synchronous stub emits before its first
  // suspension (probed against effect@4.0.0-rc.112: yes, all elements), so
  // the `yieldNow` the commands already get is enough. Emissions arrive as
  // queue entries; give them `origin: "subscription"` and treat them like
  // `"command"` for `emitted`.
  it("06 · a synchronous stub declared by `Mounted`'s fold is folded before `run` resolves", async () => {
    const feature = makeFeature({ subscriptions: () => ({ feed: ticks("a", "b") }) });

    const { state, emitted } = await runWith(feature, [{ _tag: "Mounted" }]);

    expect(emitted).toEqual([
      { _tag: "Tick", id: "a" },
      { _tag: "Tick", id: "b" },
    ]);
    expect(state.seen).toEqual(["a", "b"]);
  });

  // HINT: at exit, read the declared keys (record order, so `Object.keys` of
  // the last evaluation), then `Fiber.interruptAll` over the subscription
  // book, awaited — a finalizer inside one must have run before the caller
  // reads the result.
  it("07 · the result names the declared keys in record order, with every fiber interrupted", async () => {
    const log: Array<string> = [];
    const feature = makeFeature({
      subscriptions: () => ({ zeta: logged(log, "zeta"), alpha: logged(log, "alpha") }),
    });

    const { subscriptions } = await runWith(feature, [{ _tag: "Mounted" }]);

    expect(subscriptions).toEqual(["zeta", "alpha"]);
    expect(log).toContain("zeta:stop");
    expect(log).toContain("alpha:stop");
  });

  // HINT: the leaf receives `Dispatcher<Emit<A, O>>`. Routing is by tag, the
  // same `isOutput` check the command path uses — a subscription needs no
  // second emit function, only a different origin label.
  it("08 · what a subscription dispatches lands in `emitted` or `outputs` by tag", async () => {
    const feature = makeFeature({
      subscriptions: () => ({
        feed: Subscription.effect((dispatch: any) =>
          Effect.andThen(dispatch({ _tag: "Out", id: "o1" }), dispatch({ _tag: "Tick", id: "t1" })),
        ),
      }),
    });

    const { emitted, outputs } = await runWith(feature, [{ _tag: "Mounted" }, { _tag: "Same" }]);

    expect(outputs).toEqual([{ _tag: "Out", id: "o1" }]);
    expect(emitted).toEqual([{ _tag: "Tick", id: "t1" }]);
  });

  // HINT: spec "A subscription whose effect completes is done, not restarted."
  // The book entry keeps `status: "done"`; the diff treats a declared key that
  // is present in the book — whatever its status — as unchanged.
  it("09 · a completed subscription is not restarted while its key stays declared", async () => {
    const feature = makeFeature({ subscriptions: () => ({ feed: ticks("a") }) });

    const { emitted } = await runWith(feature, [
      { _tag: "Mounted" },
      { _tag: "Go" },
      { _tag: "Go" },
    ]);

    expect(emitted).toEqual([{ _tag: "Tick", id: "a" }]);
  });

  // HINT: when a key leaves the declared set, delete its book entry (after the
  // interrupt); when it returns, it is `declared ∖ running` again.
  it("10 · a completed subscription starts again when its key leaves and returns", async () => {
    const feature = makeFeature({
      subscriptions: ({ state }) => (state.n % 2 === 0 ? { feed: ticks("a") } : {}),
    });

    // n: 0 (declared) → 1 (gone) → 2 (back).
    const { emitted } = await runWith(feature, [
      { _tag: "Mounted" },
      { _tag: "Go" },
      { _tag: "Go" },
    ]);

    expect(emitted).toEqual([
      { _tag: "Tick", id: "a" },
      { _tag: "Tick", id: "a" },
    ]);
  });

  // HINT: spec "Failure". Mirror `commandInterpreter`'s `onExit`: a watcher
  // forked on `Fiber.await(fiber)`; a non-interrupt failure (`Exit.isFailure`
  // and not `Cause.hasInterruptsOnly`) is a defect with `from` = the key, and
  // an `Error` fold when the feature handles it. Queue the `Error` before the
  // fiber leaves the book, or quiescence can land between death and fold.
  it("11 · a dying subscription is a defect `from` its key, and `Error` folds", async () => {
    const feature = makeFeature({
      subscriptions: () => ({ feed: Subscription.effect(() => Effect.die(new Error("boom"))) }),
    });

    const { state, defects } = await runWith(feature, [{ _tag: "Mounted" }]);

    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ from: "feed", handled: true });
    expect(String(defects[0].error)).toContain("boom");
    expect(state.errors).toBe(1);
  });

  // HINT: an `Unmounted` action empties the declared set instead of evaluating
  // the hook — `stop()` does the same on the store.
  it("12 · seeding `Unmounted` empties the declared set", async () => {
    const log: Array<string> = [];
    const feature = makeFeature({ subscriptions: () => ({ feed: logged(log, "feed") }) });

    const { subscriptions } = await runWith(feature, [{ _tag: "Mounted" }, { _tag: "Unmounted" }]);

    expect(subscriptions).toEqual([]);
    expect(log).toEqual(["feed:start", "feed:stop"]);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — the diff, on the store
// ---------------------------------------------------------------------------

describe("Part 3 — the diff", () => {
  // HINT: spec "Technical Requirements": `reconcile(from, cause)` on the store,
  // called from `start()` after `fold({ _tag: "Mounted" })`. It evaluates the
  // hook, diffs against `mount.subscriptions` (the second book, per `Mount`),
  // reports `SubscriptionStarted` synchronously, and offers one
  // `{ _tag: "Subscriptions", stop, start }` `Work` item to the mount queue.
  // The fork itself happens on the mount fiber: it needs the mount's scope and
  // services, so it cannot happen in the fold.
  it("13 · `start()` starts the set declared for the post-`Mounted` snapshot", async () => {
    const log: Array<string> = [];
    const { store, recorder } = makeStore({ subscriptions: () => ({ feed: logged(log, "feed") }) });

    store.start();
    await settle();

    expect(log).toEqual(["feed:start"]);
    expect(tagged(recorder.events, "SubscriptionStarted")).toEqual([
      {
        _tag: "SubscriptionStarted",
        name: "room",
        instance: expect.any(String),
        cause: { _tag: "Lifecycle" },
        key: "feed",
      },
    ]);
  });

  // HINT: second call site — the `finally` of `fold`, when `moved`, outside
  // the `folding` guard (the hook is pure; `reconcile` offers, it does not
  // fold). Keys only: `declared ∖ running` starts, the intersection is
  // untouched.
  it("14 · a fold that declares a new key starts that key and only that key", async () => {
    const log: Array<string> = [];
    const { store, recorder } = makeStore({
      subscriptions: ({ state }) => ({
        base: logged(log, "base"),
        ...(state.n > 0 ? { extra: logged(log, "extra") } : {}),
      }),
    });

    store.start();
    await settle();
    store.dispatch({ _tag: "Go" });
    await settle();

    expect(log).toEqual(["base:start", "extra:start"]);
    expect(tagged(recorder.events, "SubscriptionStarted").map((e) => e.key)).toEqual([
      "base",
      "extra",
    ]);
  });

  // HINT: `running ∖ declared` → `SubscriptionStopped { reason: "Undeclared" }`
  // reported at the diff, then `Fiber.interruptAll` on the mount fiber,
  // awaited, then the book entry deleted.
  it("15 · a fold that no longer declares a running key stops it", async () => {
    const log: Array<string> = [];
    const { store, recorder } = makeStore({
      subscriptions: ({ state }) => (state.n === 0 ? { feed: logged(log, "feed") } : {}),
    });

    store.start();
    await settle();
    store.dispatch({ _tag: "Go" });
    await settle();

    expect(log).toEqual(["feed:start", "feed:stop"]);
    expect(tagged(recorder.events, "SubscriptionStopped")).toEqual([
      expect.objectContaining({ key: "feed", reason: "Undeclared", cause: { _tag: "Dispatch" } }),
    ]);
  });

  // HINT: spec "Once per drain, not once per action." One `fold` call drains
  // everything in `pending`; `reconcile` runs once after the loop. The three
  // dispatches below land in one drain because `emit` (the `on<Tag>` prop)
  // runs *inside* the fold of the `Out` dispatch, so its dispatches re-enter
  // `fold` and are queued rather than folded.
  it("16 · one drain evaluates the hook once, against the final state", async () => {
    const log: Array<string> = [];
    let evaluated = 0;
    const { store, recorder } = makeStore({
      subscriptions: ({ state }) => {
        evaluated += 1;
        return { [`step:${state.n}`]: logged(log, `step:${state.n}`) };
      },
      emit: () => {
        store.dispatch({ _tag: "Go" });
        store.dispatch({ _tag: "Go" });
        store.dispatch({ _tag: "Go" });
      },
    });

    store.start();
    expect(evaluated).toBe(1);

    store.dispatch({ _tag: "Out", id: "kick" } as never);
    await settle();

    expect(evaluated).toBe(2);
    expect(tagged(recorder.events, "SubscriptionStarted").map((e) => e.key)).toEqual([
      "step:0",
      "step:3",
    ]);
  });

  // HINT: `moved` is already computed by `foldOne`; no move, no reconcile.
  it("17 · a fold that returns the same state reference does not evaluate the hook", () => {
    let evaluated = 0;
    const { store } = makeStore({
      subscriptions: () => {
        evaluated += 1;
        return {};
      },
    });

    store.start();
    store.dispatch({ _tag: "Same" });

    expect(evaluated).toBe(1);
  });

  // HINT: third call site — `sync`, after its folds, when props or hooks
  // moved. A `PropsChanged` handler returning the same state is the case the
  // `fold`-site misses, and a key built from props has to restart anyway.
  it("18 · `sync` with changed props evaluates the hook even when the handler returned the same state", async () => {
    const log: Array<string> = [];
    const { store } = makeStore({
      reducer: { PropsChanged: (_a: unknown, { state }: Snap) => state },
      subscriptions: ({ props }) => ({ [`room:${props.room}`]: logged(log, `room:${props.room}`) }),
    });

    store.sync({ room: "a" }, {});
    store.start();
    await settle();
    store.sync({ room: "b" }, {});
    await settle();

    expect(log).toEqual(["room:a:start", "room:a:stop", "room:b:start"]);
  });

  // HINT: spec "Only while a mount is live." `reconcile` returns early when
  // `mount === undefined`. Do not buffer a `Subscriptions` item the way
  // commands are buffered before `start()`: `start()` evaluates from scratch.
  it("19 · before `start()` and after `stop()`, nothing starts", async () => {
    const log: Array<string> = [];
    const { store, recorder } = makeStore({
      subscriptions: ({ state, props }) => ({
        [`room:${props.room}`]: logged(log, `room:${props.room}`),
        ...(state.n > 0 ? { extra: logged(log, "extra") } : {}),
      }),
    });

    store.sync({ room: "a" }, {});
    store.sync({ room: "b" }, {});
    await settle();
    expect(log).toEqual([]);
    expect(tagged(recorder.events, "SubscriptionStarted")).toEqual([]);

    store.start();
    await settle();
    store.stop();
    await settle();
    store.dispatch({ _tag: "Go" });
    await settle();

    expect(log).toEqual(["room:b:start", "room:b:stop"]);
  });

  // HINT: the contract, pinned. Nothing to implement beyond 14: the key is the
  // identity, and the closure is invisible.
  it("20 · an unchanged key across a props change keeps the old fiber, closure and all", async () => {
    const log: Array<string> = [];
    const { store } = makeStore({
      subscriptions: ({ props }) => ({
        feed: Subscription.effect(() =>
          Effect.andThen(
            Effect.sync(() => void log.push(`feed:${props.room}`)),
            Effect.never,
          ),
        ),
      }),
    });

    store.sync({ room: "a" }, {});
    store.start();
    await settle();
    store.sync({ room: "b" }, {});
    await settle();

    expect(log).toEqual(["feed:a"]);
  });

  // HINT: the `Subscriptions` work item is interpreted stops first (awaited),
  // then starts, so a key flip releases before it re-acquires.
  it("21 · stops are interpreted before starts within one diff", async () => {
    const log: Array<string> = [];
    const { store } = makeStore({
      subscriptions: ({ state }) =>
        state.n === 0 ? { old: logged(log, "old") } : { fresh: logged(log, "fresh") },
    });

    store.start();
    await settle();
    store.dispatch({ _tag: "Go" });
    await settle();

    expect(log).toEqual(["old:start", "old:stop", "fresh:start"]);
  });

  // HINT: `feature.subscriptions(snapshot())` inside `try/catch`; a throw goes
  // to `raiseDefect(error, from, cause)` and `reconcile` returns without
  // touching the declared set. `from` is the tag of the action whose fold
  // triggered the diff.
  it("22 · a throwing hook is one defect `from` the triggering action, and the previous set stands", async () => {
    const log: Array<string> = [];
    const { store, recorder } = makeStore({
      subscriptions: ({ state }) => {
        if (state.n === 1 && state.errors === 0) throw new Error("hook boom");
        return { feed: logged(log, "feed") };
      },
    });

    store.start();
    await settle();
    store.dispatch({ _tag: "Go" });
    await settle();

    expect(store.getSnapshot().errors).toBe(1);
    expect(tagged(recorder.events, "Defect")).toEqual([
      expect.objectContaining({ from: "Go", handled: true }),
    ]);
    expect(log).toEqual(["feed:start"]);
  });

  // HINT: spec "Only while a mount is live": the mount's `catchCause` clears
  // the declared set beside `dead = true`. The re-arm path (`offer` calling
  // `start()`) then evaluates from scratch on the rebuilt layer.
  it("23 · after a layer failure the declared set is cleared, and a re-arm starts afresh", async () => {
    const log: Array<string> = [];
    let attempts = 0;
    const layer = Layer.effectDiscard(
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1 ? Effect.fail("nope") : Effect.void;
      }),
    );
    const { store } = makeStore({
      layer: layer as unknown as Layer.Layer<any, any, any>,
      subscriptions: () => ({ feed: logged(log, "feed") }),
    });

    store.start();
    await settle();
    expect(store.getSnapshot().errors).toBe(1);
    expect(log).toEqual([]);

    store.dispatch({ _tag: "Go" });
    await settle();

    expect(attempts).toBe(2);
    expect(log).toEqual(["feed:start"]);
  });
});

// ---------------------------------------------------------------------------
// Part 4 — teardown
// ---------------------------------------------------------------------------

describe("Part 4 — teardown", () => {
  // HINT: spec "Teardown", step 1. In `stop()`, before `feature.reduce(Unmounted)`:
  // clear the declared set and report `SubscriptionStopped { reason: "Unmounted" }`
  // per key in the mount's book.
  it("24 · `stop()` reports `Unmounted` stops before the `Unmounted` transition", async () => {
    const { store, recorder } = makeStore({
      subscriptions: () => ({ feed: Subscription.effect(() => Effect.never) }),
    });

    store.start();
    await settle();
    store.stop();

    const tags = recorder.events.map((e) =>
      e._tag === "Transition"
        ? `Transition:${e.action._tag}`
        : e._tag === "SubscriptionStopped"
          ? `Stopped:${e.reason}`
          : e._tag,
    );
    expect(tags.indexOf("Stopped:Unmounted")).toBeGreaterThan(-1);
    expect(tags.indexOf("Stopped:Unmounted")).toBeLessThan(tags.indexOf("Transition:Unmounted"));
  });

  // HINT: steps 3–4. In the mount fiber's `teardown`: `Fiber.interruptAll`
  // over the subscription book, awaited, *then* `interpret` the `Unmounted`
  // command. The old `Fiber.interruptAll(allFibers(cells.book))` line goes.
  it("25 · teardown interrupts subscriptions, awaited, before the `Unmounted` command runs", async () => {
    const log: Array<string> = [];
    const { store } = makeStore({
      reducer: {
        Unmounted: (_a: unknown, { state }: Snap) => [
          state,
          Command.effect(() => Effect.sync(() => void log.push("unmounted-cmd"))),
        ],
      },
      subscriptions: () => ({ feed: logged(log, "feed") }),
    });

    store.start();
    await settle();
    store.stop();
    await settle();

    expect(log).toEqual(["feed:start", "feed:stop", "unmounted-cmd"]);
  });

  // HINT: step 5 is the existing drain, unchanged — with the interrupt gone,
  // the command simply finishes and its emission folds into store state.
  it("26 · an in-flight command runs to completion across unmount, and what it emits folds", async () => {
    const { store } = makeStore({
      reducer: {
        Go: (_a: unknown, { state }: Snap) => [
          state,
          Command.effect((dispatch: any) =>
            Effect.andThen(Effect.sleep("50 millis"), dispatch({ _tag: "Tick", id: "late" })),
          ),
        ],
      },
    });

    store.start();
    store.dispatch({ _tag: "Go" });
    store.stop();
    await settle(120);

    expect(store.getSnapshot().seen).toEqual(["late"]);
  });

  // HINT: kill-on-exit is now the opt-in. The `Cancel` reaches the fiber
  // because the `Unmounted` command runs *before* the drain. Green today
  // (the sweep does the same job) — it is 26's control and must stay green.
  it("27 · `Unmounted` returning `Command.cancel` interrupts the in-flight command", async () => {
    const { store } = makeStore({
      reducer: {
        Go: (_a: unknown, { state }: Snap) => [
          state,
          Command.effect((dispatch: any) =>
            Effect.andThen(Effect.sleep("50 millis"), dispatch({ _tag: "Tick", id: "late" })),
          ),
        ],
        Unmounted: (_a: unknown, { state }: Snap) => [state, Command.cancel("Go")],
      },
    });

    store.start();
    store.dispatch({ _tag: "Go" });
    store.stop();
    await settle(120);

    expect(store.getSnapshot().seen).toEqual([]);
  });

  // HINT: the existing `timeoutOption("5 seconds")` around `teardown` already
  // does this; the test only proves the command is no longer swept before it
  // has the chance to overrun. Under `TestClock`, wall time never passes: the
  // 10s sleep and the 5s bound both move on `adjust`.
  it('28 · a command still running at the 5s bound is one defect `from: "Unmounted"`, and the scope closes', async () => {
    const log: Array<string> = [];
    const { store, defects, runtime } = makeStore({
      clock: true,
      reducer: {
        Go: (_a: unknown, { state }: Snap) => [
          state,
          Command.effect(() =>
            Effect.sleep("10 seconds").pipe(
              Effect.ensuring(Effect.sync(() => void log.push("go:finalized"))),
            ),
          ),
        ],
        Error: undefined,
      },
    });

    store.start();
    store.dispatch({ _tag: "Go" });
    store.stop();
    await settle();
    expect(defects).toEqual([]);

    await runtime.runPromise(TestClock.adjust("5 seconds"));
    await settle();

    expect(defects).toHaveLength(1);
    expect(String(defects[0])).toContain("did not settle");
    expect(log).toEqual(["go:finalized"]);
  });

  // HINT: the `Unmounted` command runs before the drain, so a slow command
  // cannot starve it. Same budget for both.
  it("29 · the `Unmounted` command runs even when an in-flight command outlasts the bound", async () => {
    const log: Array<string> = [];
    const { store, runtime, defects } = makeStore({
      clock: true,
      reducer: {
        Go: (_a: unknown, { state }: Snap) => [
          state,
          Command.effect(() => Effect.sleep("10 seconds")),
        ],
        Unmounted: (_a: unknown, { state }: Snap) => [
          state,
          Command.effect(() => Effect.sync(() => void log.push("unmounted-cmd"))),
        ],
        Error: undefined,
      },
    });

    store.start();
    store.dispatch({ _tag: "Go" });
    store.stop();
    await settle();
    expect(log).toEqual(["unmounted-cmd"]);

    await runtime.runPromise(TestClock.adjust("5 seconds"));
    await settle();
    expect(defects).toHaveLength(1);
  });

  // HINT: `Fiber.interruptAll` over the subscriptions is *inside* `teardown`,
  // so a finalizer that hangs is under the same `timeoutOption`. The finalizer
  // is `Effect.never`, not a long `Effect.sleep`: probed against
  // effect@4.0.0-rc.112, a `TestClock` sleep inside the finalizer of an
  // interrupted fiber returns at once rather than waiting for `adjust`, so a
  // sleep would not hang and the bound would have nothing to catch.
  it("30 · a subscription whose finalizer hangs is caught by the same bound", async () => {
    const { store, runtime, defects } = makeStore({
      clock: true,
      reducer: { Error: undefined },
      subscriptions: () => ({
        stuck: Subscription.effect(() => Effect.never.pipe(Effect.ensuring(Effect.never))),
      }),
    });

    store.start();
    await settle();
    store.stop();
    await settle();
    expect(defects).toEqual([]);

    await runtime.runPromise(TestClock.adjust("5 seconds"));
    await settle();

    expect(defects).toHaveLength(1);
    expect(String(defects[0])).toContain("did not settle");
  });

  // HINT: the subscription book is per `Mount`, so the second `start()` has an
  // empty one and starts every declared key once. The first mount's fibers
  // went with its `stop()`.
  it("31 · `stop(); start()` starts every declared key exactly once on the second mount", async () => {
    const log: Array<string> = [];
    const { store, recorder } = makeStore({ subscriptions: () => ({ feed: logged(log, "feed") }) });

    store.start();
    await settle();
    store.stop();
    await settle();
    store.start();
    await settle();

    expect(log).toEqual(["feed:start", "feed:stop", "feed:start"]);
    expect(tagged(recorder.events, "SubscriptionStarted")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Part 5 — failure
// ---------------------------------------------------------------------------

describe("Part 5 — failure", () => {
  // HINT: spec "Failure". The watcher on `Fiber.await`: mark the entry `died`,
  // `raiseDefect(error, key, { _tag: "Subscription", key })`, then report
  // `SubscriptionStopped { reason: "Died" }`. `raiseDefect` already emits the
  // `Defect` event and folds `Error` with `cause: { _tag: "Defect", from }`.
  it("32 · a death is `Defect` → `Error` transition → `SubscriptionStopped(Died)`, all `from` the key", async () => {
    const { store, recorder } = makeStore({
      subscriptions: () => ({ feed: Subscription.effect(() => Effect.die(new Error("boom"))) }),
    });

    store.start();
    await settle();

    const trail = recorder.events.filter(
      (e) =>
        e._tag === "Defect" ||
        e._tag === "SubscriptionStopped" ||
        (e._tag === "Transition" && e.action._tag === "Error"),
    );
    expect(trail).toEqual([
      expect.objectContaining({
        _tag: "Defect",
        from: "feed",
        handled: true,
        cause: { _tag: "Subscription", key: "feed" },
      }),
      expect.objectContaining({
        _tag: "Transition",
        action: { _tag: "Error", from: "feed" },
        cause: { _tag: "Defect", from: "feed" },
      }),
      expect.objectContaining({
        _tag: "SubscriptionStopped",
        key: "feed",
        reason: "Died",
        cause: { _tag: "Subscription", key: "feed" },
      }),
    ]);
    expect(store.getSnapshot().errors).toBe(1);
  });

  // HINT: a `died` entry stays in the book; the diff sees the key as running.
  // Only leaving the declared set deletes the entry. Note the two back-to-back
  // dispatches at the end: the second fold runs before the mount fiber has
  // interpreted the first's `Subscriptions` item, so "running" cannot be read
  // off the book alone — diff against the store's previous declared set
  // (synchronous, and equal to the book's key set once every item is
  // interpreted), and let the book carry only fibers and status.
  it("33 · a died key still declared is not restarted; one that leaves and returns is", async () => {
    let starts = 0;
    const { store } = makeStore({
      subscriptions: ({ state }) =>
        state.n === 2
          ? {}
          : {
              feed: Subscription.effect(() =>
                Effect.suspend(() => {
                  starts += 1;
                  return Effect.die(new Error("boom"));
                }),
              ),
            },
    });

    store.start();
    await settle();
    expect(starts).toBe(1);

    store.dispatch({ _tag: "Go" }); // n = 1, still declared, still dead
    await settle();
    expect(starts).toBe(1);

    store.dispatch({ _tag: "Go" }); // n = 2, gone
    store.dispatch({ _tag: "Go" }); // n = 3, back
    await settle();
    expect(starts).toBe(2);
  });

  // HINT: two books. `Cancel` reads the fiber book only; a subscription key
  // and a command group are different namespaces that happen to share a string.
  it("34 · `Command.cancel(name)` interrupts the command group and leaves the same-named subscription running", async () => {
    const log: Array<string> = [];
    const { store } = makeStore({
      reducer: {
        Go: (_a: unknown, { state }: Snap) => [
          state,
          Command.keyed(
            "work",
            Command.effect(() =>
              Effect.never.pipe(Effect.ensuring(Effect.sync(() => void log.push("cmd:stop")))),
            ),
          ),
        ],
      },
      subscriptions: () => ({ work: logged(log, "work") }),
    });

    store.start();
    store.dispatch({ _tag: "Go" });
    await settle();
    store.dispatch({ _tag: "Kill" });
    await settle();

    expect(log).toEqual(["work:start", "cmd:stop"]);
  });
});

// ---------------------------------------------------------------------------
// Part 6 — devtools
// ---------------------------------------------------------------------------

describe("Part 6 — devtools", () => {
  // HINT: `devtools.specs.md` "Subscriptions". Two event members, a fifth
  // cause. Reported inside `reconcile`, synchronously, before the work item is
  // offered — so before any fiber runs — under the `const target = devtools();
  // if (target !== undefined)` shape.
  it("35 · `SubscriptionStarted` is reported at the diff, before the fiber runs, with the fold's cause", async () => {
    const log: Array<string> = [];
    const { store, recorder } = makeStore({
      subscriptions: ({ state }) => ({
        base: logged(log, "base"),
        ...(state.n > 0 ? { extra: logged(log, "extra") } : {}),
      }),
    });

    store.start();
    expect(log).toEqual([]);
    expect(tagged(recorder.events, "SubscriptionStarted")).toEqual([
      expect.objectContaining({ key: "base", cause: { _tag: "Lifecycle" } }),
    ]);

    store.dispatch({ _tag: "Go" });
    expect(tagged(recorder.events, "SubscriptionStarted").at(-1)).toEqual(
      expect.objectContaining({ key: "extra", cause: { _tag: "Dispatch" } }),
    );
    await settle();
  });

  // HINT: the watcher on `Fiber.await`, success branch: status `done`, then
  // `SubscriptionStopped { reason: "Completed" }` with the subscription cause.
  it("36 · a subscription whose effect returns is reported `Completed`", async () => {
    const { store, recorder } = makeStore({
      subscriptions: () => ({ once: Subscription.effect(() => Effect.void) }),
    });

    store.start();
    await settle();

    expect(tagged(recorder.events, "SubscriptionStopped")).toEqual([
      expect.objectContaining({
        key: "once",
        reason: "Completed",
        cause: { _tag: "Subscription", key: "once" },
      }),
    ]);
  });

  // HINT: `forkSubscription` binds `dispatch` to
  // `emit(action, { _tag: "Subscription", key })` — the store's `fold` with
  // that cause, routed to the mount that forked it, like `commandCause`.
  it("37 · a transition for an action a subscription dispatched carries the subscription cause", async () => {
    const { store, recorder } = makeStore({ subscriptions: () => ({ feed: ticks("a") }) });

    store.start();
    await settle();

    const tick = tagged(recorder.events, "Transition").find((e) => e.action._tag === "Tick");
    expect(tick?.cause).toEqual({ _tag: "Subscription", key: "feed" });
  });

  // HINT: nothing but strings in the two events — the key is the summary.
  it("38 · both events round-trip through JSON", async () => {
    const { store, recorder } = makeStore({
      subscriptions: ({ state }) =>
        state.n === 0 ? { feed: Subscription.effect(() => Effect.never) } : {},
    });

    store.start();
    store.dispatch({ _tag: "Go" });
    await settle();

    const events = recorder.events.filter(
      (e) => e._tag === "SubscriptionStarted" || e._tag === "SubscriptionStopped",
    );
    expect(events).toHaveLength(2);
    for (const event of events) expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  // HINT: `devtools.specs.md` "Console logger": one `log` line per event —
  // `▸ room#2  ⇉ presence:general started` / `… stopped (undeclared)` —
  // with a new `subscription` colour in `DevtoolsColors`, no group, and no
  // touch of the elapsed map.
  it("39 · the console logger prints one line per subscription event", () => {
    const calls: Array<readonly [keyof DevtoolsConsole, ReadonlyArray<unknown>]> = [];
    const record =
      (method: keyof DevtoolsConsole) =>
      (...args: ReadonlyArray<unknown>) =>
        void calls.push([method, args]);
    const spy: DevtoolsConsole = {
      group: record("group"),
      groupCollapsed: record("groupCollapsed"),
      groupEnd: record("groupEnd"),
      log: record("log"),
      error: record("error"),
    };
    const sink = createConsoleDevtools({ console: spy, timestamps: false });
    const envelope = { name: "room", instance: "2", cause: { _tag: "Lifecycle" } } as const;

    sink.onEvent({ _tag: "SubscriptionStarted", ...envelope, key: "presence:general" });
    sink.onEvent({
      _tag: "SubscriptionStopped",
      ...envelope,
      key: "presence:general",
      reason: "Undeclared",
    });

    const printed = calls.map(([, args]) => args.map(String).join(" "));
    expect(calls.map(([method]) => method)).toEqual(["log", "log"]);
    expect(printed[0]).toContain("room#2  ⇉ presence:general started");
    expect(printed[1]).toContain("room#2  ⇉ presence:general stopped (undeclared)");
  });
});

// ---------------------------------------------------------------------------
// Part 7 — beyond the exercises
//
// Coverage the acceptance criteria name and the exercises above do not reach:
// outputs from a subscription on the store, a key built from hooks, `undefined`
// as an absent entry, a throwing hook under `run`, and the re-arm rule's edges.
// ---------------------------------------------------------------------------

describe("Part 7 — beyond the exercises", () => {
  it("40 · an output a subscription dispatches leaves through `emit`, with the subscription cause", async () => {
    const { store, recorder, outputs } = makeStore({
      subscriptions: () => ({
        feed: Subscription.effect((dispatch: any) => dispatch({ _tag: "Out", id: "o1" })),
      }),
    });

    store.start();
    await settle();

    expect(outputs).toEqual([{ _tag: "Out", id: "o1" }]);
    expect(tagged(recorder.events, "Output")).toEqual([
      expect.objectContaining({
        output: { _tag: "Out", id: "o1" },
        cause: { _tag: "Subscription", key: "feed" },
      }),
    ]);
    // An output never folds, so it never re-evaluates the hook: one start.
    expect(tagged(recorder.events, "SubscriptionStarted")).toHaveLength(1);
  });

  it("41 · a key built from hooks restarts when the hook value moves", async () => {
    const log: Array<string> = [];
    const { store } = makeStore({
      subscriptions: ({ hooks }) => ({
        [`online:${(hooks as { online?: boolean }).online ?? false}`]: logged(
          log,
          `online:${(hooks as { online?: boolean }).online ?? false}`,
        ),
      }),
    });

    store.sync({ room: "a" }, { online: false });
    store.start();
    await settle();
    store.sync({ room: "a" }, { online: true });
    await settle();

    expect(log).toEqual(["online:false:start", "online:false:stop", "online:true:start"]);
  });

  it("42 · an `undefined` value is an absent entry, on the store and under `run`", async () => {
    const log: Array<string> = [];
    const hook = ({ state }: Snap) => ({
      always: logged(log, "always"),
      maybe: state.n > 0 ? logged(log, "maybe") : undefined,
    });

    const { store, recorder } = makeStore({ subscriptions: hook });
    store.start();
    await settle();
    expect(log).toEqual(["always:start"]);
    expect(tagged(recorder.events, "SubscriptionStarted").map((e) => e.key)).toEqual(["always"]);

    store.dispatch({ _tag: "Go" });
    await settle();
    expect(log).toEqual(["always:start", "maybe:start"]);

    // `feature.subscriptions` is the hook verbatim; only the diff filters.
    const feature = makeFeature({ subscriptions: hook });
    expect(
      Object.keys(
        feature.subscriptions({ state: initialState(), props: { room: "a" }, hooks: {} }),
      ),
    ).toEqual(["always", "maybe"]);
    const { subscriptions } = await runWith(feature, [{ _tag: "Mounted" }]);
    expect(subscriptions).toEqual(["always"]);
  });

  it("43 · under `run`, a throwing hook is a defect `from` the action, and the previous set stands", async () => {
    const log: Array<string> = [];
    const feature = makeFeature({
      subscriptions: ({ state }) => {
        if (state.n === 1 && state.errors === 0) throw new Error("hook boom");
        return { feed: logged(log, "feed") };
      },
    });

    const { state, defects, subscriptions } = await runWith(feature, [
      { _tag: "Mounted" },
      { _tag: "Go" },
    ]);

    expect(defects).toEqual([expect.objectContaining({ from: "Go", handled: true })]);
    expect(state.errors).toBe(1);
    expect(subscriptions).toEqual(["feed"]);
    // Started once by `Mounted`, kept across the throw and the `Error` fold,
    // stopped once at resolve.
    expect(log).toEqual(["feed:start", "feed:stop"]);
  });

  it("44 · a dispatch that declares nothing does not re-arm a dead mount", async () => {
    let attempts = 0;
    const layer = Layer.effectDiscard(
      Effect.suspend(() => {
        attempts += 1;
        return Effect.fail("nope");
      }),
    );
    const { store } = makeStore({
      layer: layer as unknown as Layer.Layer<any, any, any>,
      subscriptions: () => ({}),
    });

    store.start();
    await settle();
    expect(attempts).toBe(1);

    // `Go` moves state, but the snapshot declares no key: nothing asks for
    // the layer, so nothing rebuilds it — the rule `offer` applies to a fold
    // with no command.
    store.dispatch({ _tag: "Go" });
    await settle();
    expect(attempts).toBe(1);
  });

  it("45 · `Command.cancel` of a subscription key that is not a command group is a no-op", async () => {
    const log: Array<string> = [];
    const { store, defects } = makeStore({
      reducer: { Kill: (_a: unknown, { state }: Snap) => [state, Command.cancel("feed")] },
      subscriptions: () => ({ feed: logged(log, "feed") }),
    });

    store.start();
    await settle();
    store.dispatch({ _tag: "Kill" });
    await settle();

    expect(log).toEqual(["feed:start"]);
    expect(defects).toEqual([]);
  });
});
