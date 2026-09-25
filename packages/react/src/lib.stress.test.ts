/**
 * Stress and resilience for the core runtime, in four load shapes: many
 * mounts, high-frequency sources, deep async churn, long sessions. Run with
 * `vp run stress:node` from `packages/react`; not part of `vpr -r test`.
 *
 * Every assertion is a pass criterion from `lib.specs.md` "Performance and
 * resilience". A defect is pinned as `it.fails` with a `HINT` naming the spec
 * entry it landed in, so a later fix flips the test and the entry together.
 * Counts are at `STRESS_SCALE=1` unless said otherwise.
 */
import { Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  MiB,
  alive,
  at,
  Bump,
  burst,
  BurstProps,
  counterStore,
  Fire,
  Go,
  Hit,
  idle,
  Kill,
  Noop,
  probe,
  recordingRuntime,
  released,
  restarter,
  RestartProps,
  settle,
  settleHeap,
  silentRuntime,
  slope,
  spin,
  storeArgs,
  tick,
  until,
} from "./__fixtures__/stress";
import { devtoolsLayer, type DevtoolsSink } from "./devtools";
import { Action, Command, createFeatureStore, define } from "./lib";
import { Task } from "./utils/task";

class Touch extends Context.Service<Touch, { readonly touch: () => void }>()("StressTouch") {}

// ---------------------------------------------------------------------------
// Many mounts
// ---------------------------------------------------------------------------

describe("many mounts", () => {
  it("500 stores under one runtime start, dispatch and stop clean", async () => {
    const n = at(500);
    const { runtime, transitions } = recordingRuntime();
    const stores = Array.from({ length: n }, () => counterStore(runtime));

    for (const store of stores) {
      store.start();
      store.dispatch(Bump.make({}));
    }
    for (const store of stores) expect(store.getSnapshot()).toEqual({ count: 1 });
    for (const store of stores) store.stop();
    for (const store of stores) {
      const p = await released(store);
      expect(idle(p)).toBe(true);
    }

    expect(transitions("Mounted")).toHaveLength(n);
    expect(transitions("Unmounted")).toHaveLength(n);
    expect(new Set(transitions("Mounted").map((e) => e.instance)).size).toBe(n);
  });

  it("one failing per-feature layer among 200 sharing a root layer isolates the failure", async () => {
    const n = at(200);
    let rootAcquired = 0;
    class Root extends Context.Service<Root, { readonly ok: true }>()("StressRoot") {}
    const root = Layer.effect(Root)(
      Effect.sync(() => {
        rootAcquired += 1;
        return { ok: true as const };
      }),
    );
    const { runtime, tagged, transitions } = recordingRuntime(root);
    const defects: Array<unknown> = [];
    const failing = Layer.effect(Touch)(Effect.die(new Error("layer refused")));

    const stores = Array.from({ length: n }, (_, i) =>
      counterStore(runtime, {
        layer: i === 0 ? failing : undefined,
        defect: (error) => void defects.push(error),
      }),
    );
    for (const store of stores) store.start();
    for (const store of stores) store.dispatch(Bump.make({}));
    for (const store of stores.slice(1)) await settle(store);
    await spin(stores[0], (p) => p.dead);

    expect(rootAcquired).toBe(1);
    expect(tagged("Defect").map((e) => e.from)).toEqual(["Mounted"]);
    // No `Error` handler: the defect reached the boundary callback once.
    expect(defects).toHaveLength(1);
    expect(transitions("Mounted")).toHaveLength(n);
    for (const store of stores.slice(1)) expect(store.getSnapshot()).toEqual({ count: 1 });

    for (const store of stores) store.stop();
    for (const store of stores) await released(store);

    const started = performance.now();
    await runtime.dispose();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// High-frequency sources
// ---------------------------------------------------------------------------

describe("high-frequency sources", () => {
  it("a command emitting 100k actions folds every one under 3s", async () => {
    const n = at(100_000);
    const runtime = silentRuntime();
    const store = createFeatureStore({
      feature: burst,
      props: {},
      ...storeArgs(runtime, BurstProps),
    });
    let notifications = 0;
    store.subscribe(() => void (notifications += 1));
    store.start();

    const started = performance.now();
    store.dispatch(Fire.make({ n }));
    await settle(store);
    const elapsed = performance.now() - started;

    expect(store.getSnapshot()).toEqual({ hits: n, errors: 0 });
    expect(elapsed).toBeLessThan(3000);
    // Each emission is its own fold from the command's fiber, so each one
    // notifies: the count is the floor a React consumer pays in re-renders
    // offered to `useSyncExternalStore`. Recorded, not hidden.
    expect(notifications).toBeGreaterThan(0);
    expect(notifications).toBeLessThanOrEqual(n);
    expect(probe(store).mounted).toBe(true);
    store.stop();
    await released(store);
  });

  it("an output handler dispatching 10k actions re-entrantly drains in one fold", async () => {
    const n = at(10_000);
    const Out = Action.output("Out", {});
    const Emit = Action("Emit", {});
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ count: Schema.Number }),
      action: [Emit, Bump],
      output: [Out],
    }).create({
      initialState: () => ({ count: 0 }),
      reducer: {
        Emit: (_a, { state }) => [state, Command.effect((dispatch) => dispatch(Out.make({})))],
        Bump: (_a, { state }) => ({ count: state.count + 1 }),
      },
      render: () => null,
    });
    const runtime = silentRuntime();
    let peakPending = 0;
    // Assigned after the store exists; the handler closes over it.
    let store: ReturnType<typeof createFeatureStore<{}, { count: number }, any, {}>>;
    store = createFeatureStore({
      feature,
      props: {},
      ...storeArgs(runtime, Schema.Struct({}), {
        emit: () => {
          for (let i = 0; i < n; i++) store.dispatch(Bump.make({}));
          peakPending = probe(store).pending;
        },
      }),
    });
    let notifications = 0;
    store.subscribe(() => void (notifications += 1));
    store.start();

    store.dispatch(Emit.make({}));
    await settle(store);

    expect(store.getSnapshot()).toEqual({ count: n });
    // Every re-entrant dispatch queued behind the output's fold.
    expect(peakPending).toBe(n);
    // One drain, one notification.
    expect(notifications).toBe(1);
    store.stop();
    await released(store);
  });

  it("a sink that throws is disabled after one event and costs nothing after", async () => {
    const n = at(10_000);
    let calls = 0;
    const throwing: DevtoolsSink = {
      onEvent: () => {
        calls += 1;
        throw new Error("sink down");
      },
    };
    const withSink = ManagedRuntime.make(
      devtoolsLayer(throwing),
    ) as unknown as ManagedRuntime.ManagedRuntime<any, any>;
    const a = counterStore(withSink);
    const b = counterStore(silentRuntime());
    a.start();
    b.start();

    const time = (store: typeof a) => {
      const started = performance.now();
      for (let i = 0; i < n; i++) store.dispatch(Bump.make({}));
      return performance.now() - started;
    };
    // Warm both paths before timing either.
    time(a);
    time(b);
    const withThrowing = time(a);
    const without = time(b);

    expect(calls).toBe(1);
    expect(a.getSnapshot()).toEqual({ count: 2 * n });
    // Same order of magnitude; a disabled sink is a single `undefined` check.
    expect(withThrowing).toBeLessThan(without * 3 + 5);
    a.stop();
    b.stop();
    await released(a);
    await released(b);
  });

  it("10k commands offered before start() are buffered and all run", async () => {
    const n = at(10_000);
    const runtime = silentRuntime();
    const store = counterStore(runtime);

    for (let i = 0; i < n; i++) store.dispatch(Noop.make({}));
    // `buffered` is bounded only by the caller, by design; the spec says so.
    expect(probe(store).buffered).toBe(n);
    expect(probe(store).mounted).toBe(false);

    store.start();
    await settle(store);
    expect(probe(store).buffered).toBe(0);
    expect(probe(store).inFlight).toBe(0);
    store.stop();
    await released(store);
  });

  it("10k sync() calls with alternating props fold 10k PropsChanged", async () => {
    const n = at(10_000);
    const Props = Schema.Struct({ v: Schema.Number });
    const Tock = Action("Tock", {});
    const feature = define({
      props: Props,
      state: Schema.Struct({ changes: Schema.Number }),
      action: [Tock],
    }).create({
      initialState: () => ({ changes: 0 }),
      reducer: {
        Tock: (_a, { state }) => state,
        PropsChanged: (_a, { state }) => ({ changes: state.changes + 1 }),
      },
      render: () => null,
    });
    const store = createFeatureStore({
      feature,
      props: { v: 0 },
      ...storeArgs(silentRuntime(), Props),
    });
    store.sync({ v: 0 }, {});
    store.start();

    for (let i = 1; i <= n; i++) store.sync({ v: i % 2 }, {});

    expect(store.getSnapshot()).toEqual({ changes: n });
    expect(probe(store).pending).toBe(0);
    store.stop();
    await released(store);
  });
});

// ---------------------------------------------------------------------------
// Deep async churn
// ---------------------------------------------------------------------------

describe("deep async churn", () => {
  it("10k restarts into one key never book more than one live fiber for long", async () => {
    const n = at(10_000);
    const { runtime, tagged } = recordingRuntime();
    const store = createFeatureStore({
      feature: restarter(),
      props: {},
      ...storeArgs(runtime, RestartProps),
    });
    store.start();

    let peak = 0;
    for (let i = 0; i < n; i++) {
      store.dispatch(Go.make({}));
      if (i % 100 === 99) {
        // Interrupted fibers stay booked until their watcher's cleanup runs,
        // so the book can hold many exited fibers mid-batch; what must hold
        // is that at most one of them is alive.
        await tick();
        const p = probe(store);
        peak = Math.max(peak, p.live);
        expect(p.groups).toBeLessThanOrEqual(1);
        expect(p.live).toBeLessThanOrEqual(1);
      }
    }
    store.dispatch(Kill.make({}));
    await settle(store);

    expect(store.getSnapshot().issued).toBe(n);
    expect(probe(store).fibers).toBe(0);
    expect(tagged("Defect")).toHaveLength(0);
    expect(peak).toBeLessThanOrEqual(1);
    store.stop();
    await released(store);
  });

  it("1k restarts whose cancelled leaf has a 1ms finalizer stay bounded", async () => {
    const n = at(1_000);
    const store = createFeatureStore({
      feature: restarter({ finalizerMs: 1 }),
      props: {},
      ...storeArgs(silentRuntime(), RestartProps),
    });
    store.start();

    const started = performance.now();
    for (let i = 0; i < n; i++) store.dispatch(Go.make({}));
    store.dispatch(Kill.make({}));
    await settle(store, 30_000);
    const elapsed = performance.now() - started;

    // Each `Cancel` awaits the finalizer it interrupts, serially on the mount
    // loop: n finalizers at 1ms each is the floor, three times that the cap.
    expect(elapsed).toBeLessThan(n * 3 + 500);
    expect(probe(store).fibers).toBe(0);
    store.stop();
    await released(store);
  });

  it("stop() with 100 commands in flight drains them, services alive, well under the 5s bound", async () => {
    const n = at(100);
    let touched = 0;
    let finished = 0;
    const Slow = Action("Slow", {});
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ n: Schema.Number }),
      action: [Slow],
    }).create({
      initialState: () => ({ n: 0 }),
      reducer: {
        Slow: (_a, { state }) => [
          state,
          Command.effect(() =>
            Effect.sleep(20).pipe(Effect.andThen(Effect.sync(() => void (finished += 1)))),
          ),
        ],
        Unmounted: (_a, { state }) => [
          state,
          Command.effect(() => Effect.map(Touch, (svc) => svc.touch())),
        ],
      },
      render: () => null,
    });
    const store = createFeatureStore({
      feature,
      props: {},
      ...storeArgs(silentRuntime(), Schema.Struct({}), {
        layer: Layer.succeed(Touch)({ touch: () => void (touched += 1) }),
      }),
    });
    store.start();
    for (let i = 0; i < n; i++) store.dispatch(Slow.make({}));
    // The mount loop forks the queued leaves across macrotasks at scale.
    await until(store, (p) => p.inFlight === n);

    const started = performance.now();
    store.stop();
    const p = await released(store);
    const elapsed = performance.now() - started;

    expect(finished).toBe(n);
    expect(touched).toBe(1);
    expect(elapsed).toBeLessThan(500);
    expect(idle(p)).toBe(true);
  });

  it("start/stop 1k times without settling between keeps Mounted and Unmounted paired", async () => {
    const n = at(1_000);
    const { runtime, transitions } = recordingRuntime();
    const store = counterStore(runtime);

    for (let i = 0; i < n; i++) {
      store.start();
      store.dispatch(Bump.make({}));
      store.stop();
    }
    await released(store, 30_000);

    expect(transitions("Mounted")).toHaveLength(n);
    expect(transitions("Unmounted")).toHaveLength(n);
    expect(store.getSnapshot()).toEqual({ count: n });
  });

  it("an on<Tag> handler dispatching during a teardown drain either runs or is reported dropped", async () => {
    const Out = Action.output("Out", {});
    const Late = Action("Late", {});
    const Follow = Action("Follow", {});
    let ran = 0;
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ n: Schema.Number }),
      action: [Late, Follow],
      output: [Out],
    }).create({
      initialState: () => ({ n: 0 }),
      reducer: {
        Late: (_a, { state }) => [
          state,
          Command.effect((dispatch) =>
            Effect.sleep(10).pipe(Effect.andThen(dispatch(Out.make({})))),
          ),
        ],
        Follow: (_a, { state }) => [
          { n: state.n + 1 },
          Command.effect(() => Effect.sync(() => void (ran += 1))),
        ],
      },
      render: () => null,
    });
    const { runtime, tagged } = recordingRuntime();
    let store: ReturnType<typeof createFeatureStore<{}, { n: number }, any, {}>>;
    store = createFeatureStore({
      feature,
      props: {},
      ...storeArgs(runtime, Schema.Struct({}), { emit: () => store.dispatch(Follow.make({})) }),
    });
    store.start();
    store.dispatch(Late.make({}));
    store.stop();
    await released(store);

    const follow = tagged("Command").filter((e) => e.group === "Follow");
    expect(follow).toHaveLength(1);
    expect(tagged("Output")).toHaveLength(1);
    // Exactly one of: it ran on the closing mount, or it was dropped.
    expect(ran + (follow[0].dropped ? 1 : 0)).toBe(1);
  });

  it("1k commands that throw in their builder each raise one defect and fold Error", async () => {
    const n = at(1_000);
    const Boom = Action("Boom", {});
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ errors: Schema.Number }),
      action: [Boom],
    }).create({
      initialState: () => ({ errors: 0 }),
      reducer: {
        Boom: (_a, { state }) => [
          state,
          Command.effect(() => {
            throw new Error("builder threw");
          }),
        ],
        Error: (_a, { state }) => ({ errors: state.errors + 1 }),
      },
      render: () => null,
    });
    const { runtime, tagged } = recordingRuntime();
    const store = createFeatureStore({
      feature,
      props: {},
      ...storeArgs(runtime, Schema.Struct({})),
    });
    store.start();

    for (let i = 0; i < n; i++) store.dispatch(Boom.make({}));
    await settle(store);

    expect(store.getSnapshot()).toEqual({ errors: n });
    expect(tagged("Defect")).toHaveLength(n);
    expect(tagged("Defect").every((e) => e.from === "Boom" && e.handled)).toBe(true);
    expect(probe(store).fibers).toBe(0);
    store.stop();
    await released(store);
  });

  it("a command that dies after emitting folds the emission, then one Error", async () => {
    const Both = Action("Both", {});
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ hits: Schema.Number, errors: Schema.Number }),
      action: [Both, Hit],
    }).create({
      initialState: () => ({ hits: 0, errors: 0 }),
      reducer: {
        Both: (_a, { state }) => [
          state,
          Command.effect((dispatch) =>
            dispatch(Hit.make({ i: 0 })).pipe(Effect.andThen(Effect.die(new Error("after")))),
          ),
        ],
        Hit: (_a, { state }) => ({ ...state, hits: state.hits + 1 }),
        Error: (_a, { state }) => ({ ...state, errors: state.errors + 1 }),
      },
      render: () => null,
    });
    const { runtime, tagged } = recordingRuntime();
    const store = createFeatureStore({
      feature,
      props: {},
      ...storeArgs(runtime, Schema.Struct({})),
    });
    store.start();
    store.dispatch(Both.make({}));
    await settle(store);

    expect(store.getSnapshot()).toEqual({ hits: 1, errors: 1 });
    expect(tagged("Defect")).toHaveLength(1);
    store.stop();
    await released(store);
  });

  it("Task mode latest resolves once per burst, every resolves every time", async () => {
    const n = at(1_000);
    const run = async (mode: "latest" | "every") => {
      const load = Task("Load", {
        success: Schema.Number,
        onError: Task.errorMessage,
        mode,
        run: (i: number) => Effect.sleep(1).pipe(Effect.as(i)),
      });
      const Issue = Action("Issue", { i: Schema.Number });
      const feature = define({
        props: Schema.Struct({}),
        state: Schema.Struct({ value: Task.schema(Schema.Number), resolved: Schema.Number }),
        action: [Issue, ...load.actions],
      }).create({
        initialState: () => ({ value: Task.idle, resolved: 0 }),
        reducer: {
          Issue: ({ i }, { state }) => Task.start(state, "value", load.run(i)),
          LoadResolved: ({ value }, { state }) => ({
            value: Task.resolved(value),
            resolved: state.resolved + 1,
          }),
          LoadRejected: ({ error }, { state }) => ({ ...state, value: Task.rejected(error) }),
        },
        render: () => null,
      });
      const store = createFeatureStore({
        feature,
        props: {},
        ...storeArgs(silentRuntime(), Schema.Struct({})),
      });
      store.start();
      for (let i = 0; i < n; i++) store.dispatch(Issue.make({ i }));
      await settle(store, 30_000);
      const snapshot = store.getSnapshot();
      expect(probe(store).fibers).toBe(0);
      store.stop();
      await released(store);
      return snapshot;
    };

    const latest = await run("latest");
    expect(latest.resolved).toBe(1);
    expect(latest.value).toEqual({ _tag: "Resolved", value: n - 1 });

    const every = await run("every");
    expect(every.resolved).toBe(n);
  });

  // HINT: lib.specs.md "Known limitations" — a `Cancel` awaits the interrupted
  // fibers' finalizers on the mount's run loop; a hung finalizer stalls every
  // later command for that feature. Nothing bounds the in-mount case today.
  it.fails("a hung uninterruptible finalizer on Cancel does not stall the next command", async () => {
    let pinged = 0;
    const Hang = Action("Hang", {});
    const Ping = Action("Ping", {});
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ n: Schema.Number }),
      action: [Hang, Kill, Ping],
    }).create({
      initialState: () => ({ n: 0 }),
      reducer: {
        Hang: (_a, { state }) => [
          state,
          Command.keyed(
            "work",
            Command.effect(() => Effect.never.pipe(Effect.ensuring(Effect.never))),
          ),
        ],
        Kill: (_a, { state }) => [state, Command.cancel("work")],
        Ping: (_a, { state }) => [
          state,
          Command.effect(() => Effect.sync(() => void (pinged += 1))),
        ],
      },
      render: () => null,
    });
    const store = createFeatureStore({
      feature,
      props: {},
      ...storeArgs(silentRuntime(), Schema.Struct({})),
    });
    store.start();
    store.dispatch(Hang.make({}));
    await tick();
    store.dispatch(Kill.make({}));
    store.dispatch(Ping.make({}));
    await Effect.runPromise(Effect.sleep(200));

    // The mount loop is parked inside the `Cancel`, so `Ping` never runs. The
    // store is left as is: the fiber has no handle to leak.
    expect(pinged).toBe(1);
  });

  // HINT: lib.specs.md "Known limitations" — `run` resolves at command
  // quiescence, so a never-completing command holds it open. A source that
  // never completes is a subscription.
  it.fails("run resolves with a never-completing command in flight", async () => {
    const Hold = Action("Hold", {});
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({ n: Schema.Number }),
      action: [Hold],
    }).create({
      initialState: () => ({ n: 0 }),
      reducer: { Hold: (_a, { state }) => [state, Command.effect(() => Effect.never)] },
      render: () => null,
    });
    const result = await Effect.runPromise(
      feature
        .run([Hold.make({})], { props: {}, hooks: {}, layer: Layer.empty })
        .pipe(Effect.timeoutOption(200)),
    );
    expect(Option.isSome(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Long sessions
// ---------------------------------------------------------------------------

describe("long sessions", () => {
  /**
   * `rounds` of `perRound` cycles. Each cycle's `emit` closes over a fresh
   * sentinel, so the sentinel is reachable only through the store's closure
   * context: a leaked fiber holding `fold` would keep it alive. The store
   * object itself proves less, since nothing in the runtime references it.
   */
  const cycles = async (
    rounds: number,
    perRound: number,
    make: (sentinel: object) => {
      readonly store: ReturnType<typeof counterStore>;
      readonly go: () => void;
    },
  ) => {
    const refs: Array<WeakRef<object>> = [];
    const heap: Array<number> = [];
    for (let r = 0; r < rounds; r++) {
      const stores: Array<ReturnType<typeof counterStore>> = [];
      for (let i = 0; i < perRound; i++) {
        const sentinel = {};
        refs.push(new WeakRef(sentinel));
        const { store, go } = make(sentinel);
        store.start();
        go();
        store.stop();
        stores.push(store);
      }
      for (const store of stores) await spin(store, (p) => !p.mounted && idle(p));
      stores.length = 0;
      heap.push(await settleHeap());
    }
    return { refs, heap };
  };

  const assertFlat = (heap: ReadonlyArray<number>, refs: ReadonlyArray<WeakRef<object>>) => {
    const tail = heap.slice(-5);
    const growth = tail[tail.length - 1] - tail[0];
    // The first rounds warm caches and JIT; the tail is what a session pays.
    expect(growth).toBeLessThan(2 * MiB);
    expect(slope(tail)).toBeLessThan(MiB / 2);
    expect(alive(refs)).toBeLessThan(refs.length / 100);
  };

  it("10k create/start/dispatch/stop cycles leave no reachable store context", async () => {
    const runtime = silentRuntime();
    const { refs, heap } = await cycles(8, at(1_250), (sentinel) => {
      const store = counterStore(runtime, { emit: () => void sentinel });
      return { store, go: () => store.dispatch(Bump.make({})) };
    });
    assertFlat(heap, refs);
  });

  it("10k cycles with a per-feature scoped layer acquire and release in step", async () => {
    let acquired = 0;
    let releasedCount = 0;
    const scoped = Layer.effect(Touch)(
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired += 1;
          return { touch: () => {} };
        }),
        () => Effect.sync(() => void (releasedCount += 1)),
      ),
    );
    const runtime = silentRuntime();
    const { refs, heap } = await cycles(8, at(1_250), (sentinel) => {
      const store = counterStore(runtime, { layer: scoped, emit: () => void sentinel });
      return { store, go: () => store.dispatch(Bump.make({})) };
    });
    expect(acquired).toBe(at(1_250) * 8);
    expect(releasedCount).toBe(acquired);
    assertFlat(heap, refs);
  });

  it("10k drafting folds on one store retain no draft and leave the heap flat", async () => {
    const Push = Action("Push", { i: Schema.Number });
    const Trim = Action("Trim", {});
    const Props = Schema.Struct({});
    const feature = define({
      props: Props,
      state: Schema.Struct({ items: Schema.Array(Schema.Number) }),
      action: [Push, Trim],
    }).create({
      initialState: () => ({ items: [] }),
      reducer: {
        Push: ({ i }, { draft }) => {
          draft.items.push(i);
          return draft;
        },
        Trim: (_a, { draft }) => {
          draft.items.length = 0;
          return draft;
        },
      },
      render: () => null,
    });
    const runtime = silentRuntime();
    const store = createFeatureStore({ feature, props: {}, ...storeArgs(runtime, Props) });
    store.start();

    const heap: Array<number> = [];
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < at(1_250); i++) store.dispatch(Push.make({ i }));
      store.dispatch(Trim.make({}));
      heap.push(await settleHeap());
    }
    store.stop();
    await spin(store, (p) => !p.mounted);

    expect(store.getSnapshot()).toEqual({ items: [] });
    const tail = heap.slice(-5);
    expect(tail[tail.length - 1] - tail[0]).toBeLessThan(2 * MiB);
    expect(slope(tail)).toBeLessThan(MiB / 2);
  });

  it("the console sink's elapsed clock stays bounded across mounts that never unmount", async () => {
    const { createConsoleDevtools } = await import("./devtools");
    const headlines: Array<string> = [];
    const output = {
      group: () => {},
      groupCollapsed: (line: unknown) => void headlines.push(String(line)),
      groupEnd: () => {},
      log: () => {},
      error: () => {},
    };
    const sink = createConsoleDevtools({ console: output });
    const runtime = ManagedRuntime.make(
      devtoolsLayer(sink),
    ) as unknown as ManagedRuntime.ManagedRuntime<any, any>;

    // 600 mounts, each with two events, none stopped: the map passes 512 and
    // is cleared wholesale; the next event for a known mount then has no
    // `(+Nms)` figure. Pins `devtools.ts`'s bound.
    const n = 600;
    const stores = Array.from({ length: n }, () => counterStore(runtime));
    for (const store of stores) store.start();
    const before = headlines.length;
    for (const store of stores) store.dispatch(Bump.make({}));
    const second = headlines.slice(before);

    expect(headlines).toHaveLength(2 * n);
    // Every mount's second event would carry an elapsed figure if the map
    // were unbounded; at least one lost it to the clear.
    expect(second.some((line) => !line.includes("(+"))).toBe(true);

    for (const store of stores) store.stop();
    for (const store of stores) await released(store);
  });
});
