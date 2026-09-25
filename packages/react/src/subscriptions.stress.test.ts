/**
 * Stress and resilience for subscriptions: many keys across many mounts,
 * high-frequency sources, sources that die, and key churn over a long
 * session. `vp run stress:node` from `packages/react`. Findings land in
 * `subscriptions.specs.md` "Known limitations".
 */
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  MiB,
  alive,
  at,
  Declare,
  idle,
  keys,
  presence,
  PresenceProps,
  probe,
  recordingRuntime,
  released,
  settleHeap,
  slope,
  spin,
  storeArgs,
  Tick,
  tick,
  until,
} from "./__fixtures__/stress";
import { devtoolsLayer, type DevtoolsEvent, type DevtoolsSink } from "./devtools";
import { Action, createFeatureStore, define, Subscription } from "./lib";

/** A listener that only holds. */
const holding = presence(() => Effect.never);

const presenceStore = (
  feature: ReturnType<typeof presence>,
  runtime: ManagedRuntime.ManagedRuntime<any, any>,
) => {
  const store = createFeatureStore({
    feature,
    props: { room: "stress" },
    ...storeArgs(runtime, PresenceProps),
  });
  store.start();
  return store;
};

describe("many mounts", () => {
  it("200 stores each declaring 5 keys start and stop every key exactly once", async () => {
    const n = at(200);
    const { runtime, tagged } = recordingRuntime();
    const stores = Array.from({ length: n }, () => presenceStore(holding, runtime));
    for (const store of stores) store.dispatch(Declare.make({ keys: keys(5) }));
    for (const store of stores) await until(store, (p) => p.subscriptions === 5);

    for (const store of stores) store.stop();
    for (const store of stores) {
      const p = await released(store);
      expect(idle(p)).toBe(true);
      expect(p.declared).toBe(0);
    }

    expect(tagged("SubscriptionStarted")).toHaveLength(5 * n);
    const stopped = tagged("SubscriptionStopped");
    expect(stopped).toHaveLength(5 * n);
    expect(stopped.every((e) => e.reason === "Unmounted")).toBe(true);
  });
});

describe("high-frequency sources", () => {
  it("a subscription emitting 100k elements folds every one under 3s", async () => {
    const n = at(100_000);
    const firehose = presence((key, dispatch) =>
      Stream.runForEach(Stream.range(0, n - 1), (i) => dispatch(Tick.make({ key, n: i }))),
    );
    const { runtime, tagged } = recordingRuntime();
    const store = presenceStore(firehose, runtime);

    const started = performance.now();
    store.dispatch(Declare.make({ keys: ["hose"] }));
    await until(store, () => store.getSnapshot().seen === n, 10_000);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(probe(store).pending).toBe(0);
    expect(tagged("Defect")).toHaveLength(0);
    // The source completed: booked as done until undeclared.
    await until(store, () => tagged("SubscriptionStopped").length === 1);
    expect(tagged("SubscriptionStopped")[0].reason).toBe("Completed");
    expect(probe(store).subscriptions).toBe(1);

    store.dispatch(Declare.make({ keys: [] }));
    await until(store, (p) => p.subscriptions === 0);
    store.stop();
    await released(store);
  });

  it("10 sources each emitting 10k interleave without losing per-key order", async () => {
    const per = at(10_000);
    const Seen = Action("Seen", { key: Schema.String, n: Schema.Number });
    const Start = Action("Start", {});
    let violations = 0;
    const feature = define({
      props: Schema.Struct({}),
      state: Schema.Struct({
        last: Schema.Record(Schema.String, Schema.Number),
        total: Schema.Number,
      }),
      action: [Seen, Start],
    }).create({
      initialState: () => ({ last: {}, total: 0 }),
      reducer: {
        Start: (_a, { state }) => ({ ...state, total: 0 }),
        Seen: ({ key, n }, { state }) => {
          if (n !== (state.last[key] ?? -1) + 1) violations += 1;
          return { last: { ...state.last, [key]: n }, total: state.total + 1 };
        },
      },
      subscriptions: ({ state }) =>
        state.total === -1
          ? {}
          : Object.fromEntries(
              keys(10).map((key) => [
                key,
                Subscription.effect((dispatch) =>
                  Stream.runForEach(Stream.range(0, per - 1), (n) =>
                    dispatch(Seen.make({ key, n })),
                  ),
                ),
              ]),
            ),
      render: () => null,
    });
    const { runtime, tagged } = recordingRuntime();
    const store = createFeatureStore({
      feature,
      props: {},
      ...storeArgs(runtime, Schema.Struct({})),
    });
    store.start();

    await until(store, () => store.getSnapshot().total === 10 * per, 20_000);

    expect(violations).toBe(0);
    expect(tagged("Defect")).toHaveLength(0);
    // Interleaved: more than one key was mid-stream when another emitted.
    // Not asserted, since the scheduler owns it; the order per key is.
    store.stop();
    await released(store);
  });
});

describe("failure", () => {
  it("100 sources dying on the first tick each stop once and stay booked until undeclared", async () => {
    const n = 100;
    const dying = presence((key) => Effect.die(new Error(`${key} died`)));
    const { runtime, tagged } = recordingRuntime();
    const store = presenceStore(dying, runtime);

    store.dispatch(Declare.make({ keys: keys(n) }));
    await until(store, () => store.getSnapshot().errors === n);

    const died = tagged("SubscriptionStopped").filter((e) => e.reason === "Died");
    expect(died).toHaveLength(n);
    expect(new Set(died.map((e) => e.key)).size).toBe(n);
    expect(tagged("Defect").every((e) => e.handled)).toBe(true);
    // Dead entries stay in the book while declared: a still-declared key is
    // unchanged, not restarted.
    expect(probe(store).subscriptions).toBe(n);

    store.dispatch(Declare.make({ keys: [] }));
    await until(store, (p) => p.subscriptions === 0);
    // Undeclaring a dead key reports a second `Stopped`, `Undeclared`: the
    // events describe the declared set, and the key did leave it. A reader
    // counting live keys as `Started - Stopped` goes negative here. Recorded
    // in `subscriptions.specs.md` "Performance and resilience".
    const stopped = tagged("SubscriptionStopped");
    expect(stopped).toHaveLength(2 * n);
    expect(stopped.slice(n).every((e) => e.reason === "Undeclared")).toBe(true);

    store.stop();
    await released(store);
  });

  it("100 sources dying after 10 ticks fold every tick, then one Error each", async () => {
    const n = 100;
    const dying = presence((key, dispatch) =>
      Effect.gen(function* () {
        for (let i = 0; i < 10; i++) yield* dispatch(Tick.make({ key, n: i }));
        return yield* Effect.die(new Error(`${key} died`));
      }),
    );
    const { runtime, tagged } = recordingRuntime();
    const store = presenceStore(dying, runtime);

    store.dispatch(Declare.make({ keys: keys(n) }));
    await until(store, () => store.getSnapshot().errors === n);

    expect(store.getSnapshot().seen).toBe(10 * n);
    expect(tagged("SubscriptionStopped").filter((e) => e.reason === "Died")).toHaveLength(n);
    store.stop();
    await released(store);
  });

  // The mount fiber forks the declared keys in a loop that crosses the
  // scheduler's op-budget yield; a fiber forked right before the yield runs
  // before the mount fiber's booking statement. The body books itself first,
  // so a death there is still reported. Deterministic at the budget boundary:
  // `k407` of 500 under the store went unreported before that.
  it("500 sources dying on the first tick are all reported by the store", async () => {
    const n = 500;
    const dying = presence((key) => Effect.die(new Error(`${key} died`)));
    const { runtime, tagged } = recordingRuntime();
    const store = presenceStore(dying, runtime);

    store.dispatch(Declare.make({ keys: keys(n) }));
    await until(store, () => tagged("SubscriptionStopped").length >= n - 1);
    for (let i = 0; i < 10; i++) await tick();

    const stopped = new Set(tagged("SubscriptionStopped").map((e) => e.key));
    expect(keys(n).filter((key) => !stopped.has(key))).toEqual([]);
    expect(store.getSnapshot().errors).toBe(n);

    store.stop();
    await released(store);
  });

  // The same boundary under `Feature.run`, whose `fork` books on the same
  // terms. `k812` of 1000 went unreported before the body booked itself.
  it("1000 sources dying on the first tick are all reported by run", async () => {
    const n = 1000;
    const dying = presence((key) => Effect.die(new Error(`${key} died`)));
    const result = await Effect.runPromise(
      dying.run([Declare.make({ keys: keys(n) })], {
        props: { room: "run" },
        hooks: {},
        layer: Layer.empty,
      }),
    );
    const seen = new Set(result.defects.map((d) => d.from));
    expect(keys(n).filter((key) => !seen.has(key))).toEqual([]);
    expect(result.state.errors).toBe(n);
  });
});

describe("long sessions", () => {
  it("10k mount cycles with 3 keys each start and stop 30k subscriptions and leave no context", async () => {
    const rounds = 8;
    const perRound = at(1_250);
    const counts = new Map<string, number>();
    const sink: DevtoolsSink = {
      onEvent: (event) => void counts.set(event._tag, (counts.get(event._tag) ?? 0) + 1),
    };
    const count = (tag: DevtoolsEvent["_tag"]) => counts.get(tag) ?? 0;
    const runtime = ManagedRuntime.make(
      devtoolsLayer(sink),
    ) as unknown as ManagedRuntime.ManagedRuntime<any, any>;

    const refs: Array<WeakRef<object>> = [];
    const heap: Array<number> = [];
    for (let r = 0; r < rounds; r++) {
      const stores: Array<ReturnType<typeof presenceStore>> = [];
      for (let i = 0; i < perRound; i++) {
        const sentinel = {};
        refs.push(new WeakRef(sentinel));
        const store = createFeatureStore({
          feature: holding,
          props: { room: "long" },
          ...storeArgs(runtime, PresenceProps, { emit: () => void sentinel }),
        });
        store.start();
        store.dispatch(Declare.make({ keys: keys(3) }));
        store.stop();
        stores.push(store);
      }
      for (const store of stores) await spin(store, (p) => !p.mounted && idle(p));
      stores.length = 0;
      heap.push(await settleHeap());
    }

    expect(count("SubscriptionStarted")).toBe(3 * rounds * perRound);
    expect(count("SubscriptionStopped")).toBe(3 * rounds * perRound);
    const tail = heap.slice(-5);
    expect(tail[tail.length - 1] - tail[0]).toBeLessThan(2 * MiB);
    expect(slope(tail)).toBeLessThan(MiB / 2);
    expect(alive(refs)).toBeLessThan(refs.length / 100);
  });
});
