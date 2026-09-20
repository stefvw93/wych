/**
 * Property tests over the runtime, with `FastCheck` from `effect/testing`.
 *
 * The differential check drives the same feature two ways, `Feature.run` and
 * a hand-driven `createFeatureStore`, and asserts they agree. The two share
 * one interpreter; the property is what pins that they also share one
 * *schedule* for commands that complete before the next action is reduced.
 * Commands that suspend (`Restart`) are excluded from the differential and
 * covered by the invariant properties instead: `run` yields once per action
 * and the store is settled per dispatch, so a suspending leaf sees a `Cancel`
 * under `run` that it outran under the store. That is a difference in how the
 * two are driven, not in the runtime.
 */
import { Effect, Layer, Schema } from "effect";
import { FastCheck as fc } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";
import {
  Go,
  idle,
  Kill,
  probe,
  recordingRuntime,
  released,
  restarter,
  RestartProps,
  settle,
  silentRuntime,
  storeArgs,
  tick,
} from "./__fixtures__/stress";
import { Action, Command, createFeatureStore, define } from "./lib";

// ---------------------------------------------------------------------------
// The feature under test
// ---------------------------------------------------------------------------

const Inc = Action("Inc", {});
const Dec = Action("Dec", {});
const Echo = Action("Echo", { n: Schema.Number });
const Echoed = Action("Echoed", { n: Schema.Number });
const Twice = Action("Twice", {});
const Restart = Action("Restart", { k: Schema.Number });
const Cancel = Action("Cancel", {});

const State = Schema.Struct({ n: Schema.Number, log: Schema.Array(Schema.Number) });

const differential = define({
  props: Schema.Struct({}),
  state: State,
  action: Action.of([Inc, Dec, Echo, Echoed, Twice, Restart, Cancel]),
}).create({
  initialState: () => ({ n: 0, log: [] }),
  reducer: {
    Inc: (_a, { state }) => ({ ...state, n: state.n + 1 }),
    Dec: (_a, { state }) => ({ ...state, n: state.n - 1 }),
    // Emits without suspending: folded before the next action under both drivers.
    Echo: ({ n }, { state }) => [state, Command.effect((dispatch) => dispatch(Echoed.make({ n })))],
    Echoed: ({ n }, { state }) => ({ ...state, log: [...state.log, n] }),
    Twice: (_a, { state }) => [
      state,
      Command.batch(
        Command.effect((dispatch) => dispatch(Echoed.make({ n: -1 }))),
        Command.effect((dispatch) => dispatch(Echoed.make({ n: -2 }))),
      ),
    ],
    // Suspends once, then emits: take-latest under one key.
    Restart: ({ k }, { state }) => [
      state,
      Command.restart(
        "r",
        Command.effect((dispatch) =>
          Effect.yieldNow.pipe(Effect.andThen(dispatch(Echoed.make({ n: 1000 + k })))),
        ),
      ),
    ],
    Cancel: (_a, { state }) => [state, Command.cancel("r")],
  },
  render: () => null,
});

type Msg = { readonly _tag: string; readonly [key: string]: unknown };

const settling = fc.oneof(
  fc.constant(Inc.make({}) as Msg),
  fc.constant(Dec.make({}) as Msg),
  fc.integer({ min: 0, max: 99 }).map((n) => Echo.make({ n }) as Msg),
  fc.constant(Twice.make({}) as Msg),
);

const suspending = fc.oneof(
  fc.integer({ min: 0, max: 9 }).map((k) => Restart.make({ k }) as Msg),
  fc.constant(Cancel.make({}) as Msg),
);

const sequence = (arb: fc.Arbitrary<Msg>) => fc.array(arb, { maxLength: 50 });

/** Drive the store by hand: start, dispatch each with a settle between, stop. */
const viaStore = async (actions: ReadonlyArray<Msg>) => {
  const { runtime, tagged } = recordingRuntime();
  const store = createFeatureStore({
    feature: differential,
    props: {},
    ...storeArgs(runtime, Schema.Struct({})),
  });
  store.start();
  for (const action of actions) {
    store.dispatch(action as never);
    await settle(store);
  }
  const state = store.getSnapshot();
  const emitted = tagged("Transition")
    .filter((e) => e.cause._tag === "Command")
    .map((e) => e.action);
  store.stop();
  const p = await released(store);
  return { state, emitted, probe: p };
};

const viaRun = (actions: ReadonlyArray<Msg>) =>
  Effect.runPromise(
    differential.run(actions as never, { props: {}, hooks: {}, layer: Layer.empty }),
  );

// ---------------------------------------------------------------------------

describe("differential", () => {
  it("run and the hand-driven store agree on state and emission order for settling commands", async () => {
    await fc.assert(
      fc.asyncProperty(sequence(settling), async (actions) => {
        const [ran, stored] = await Promise.all([viaRun(actions), viaStore(actions)]);
        expect(stored.state).toEqual(ran.state);
        expect(stored.emitted).toEqual(ran.emitted);
        expect(idle(stored.probe)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe("invariants", () => {
  it("after any sequence and stop(), every book is empty and the log matches what was emitted", async () => {
    await fc.assert(
      fc.asyncProperty(sequence(fc.oneof(settling, suspending)), async (actions) => {
        const { state, emitted, probe: p } = await viaStore(actions);
        expect(idle(p)).toBe(true);
        expect(p.mounted).toBe(false);
        // Every `Echoed` the store folded is in the log, in order; nothing else is.
        expect(state.log).toEqual(emitted.map((e) => (e as unknown as { readonly n: number }).n));
        // `Inc`/`Dec` are the only writers of `n`.
        const expectedN = actions.reduce(
          (n, a) => n + (a._tag === "Inc" ? 1 : a._tag === "Dec" ? -1 : 0),
          0,
        );
        expect(state.n).toBe(expectedN);
      }),
      { numRuns: 200 },
    );
  });

  it("restart never leaves two fibers booked under one key after a macrotask", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 200 }), async (n) => {
        const store = createFeatureStore({
          feature: restarter(),
          props: {},
          ...storeArgs(silentRuntime(), RestartProps),
        });
        store.start();
        for (let i = 0; i < n; i++) {
          store.dispatch(Go.make({}));
          await tick();
          const p = probe(store);
          expect(p.groups).toBeLessThanOrEqual(1);
          expect(p.live).toBeLessThanOrEqual(1);
        }
        // Kill-on-exit is the feature's job: a never-ending leaf would hold
        // the teardown drain to its 5s bound.
        store.dispatch(Kill.make({}));
        await settle(store);
        store.stop();
        expect(idle(await released(store))).toBe(true);
      }),
      { numRuns: 25 },
    );
  });

  it("Schema.toEquivalence is reflexive on structural clones, so sync folds no PropsChanged", async () => {
    const Props = Schema.Struct({
      id: Schema.String,
      count: Schema.Number,
      on: Schema.Boolean,
      tags: Schema.Array(Schema.String),
      nested: Schema.Struct({ a: Schema.Number, b: Schema.String }),
    });
    const equivalence = Schema.toEquivalence(Props);
    const Tock = Action("Tock", {});
    const feature = define({
      props: Props,
      state: Schema.Struct({ changes: Schema.Number }),
      action: Action.of([Tock]),
    }).create({
      initialState: () => ({ changes: 0 }),
      reducer: {
        Tock: (_a, { state }) => state,
        PropsChanged: (_a, { state }) => ({ changes: state.changes + 1 }),
      },
      render: () => null,
    });
    const arb = fc.record({
      id: fc.string(),
      count: fc.double({ noNaN: true }),
      on: fc.boolean(),
      tags: fc.array(fc.string(), { maxLength: 5 }),
      nested: fc.record({ a: fc.integer(), b: fc.string() }),
    });

    await fc.assert(
      fc.asyncProperty(arb, async (props) => {
        const clone = structuredClone(props);
        expect(equivalence(props, clone)).toBe(true);
        const store = createFeatureStore({
          feature,
          props,
          ...storeArgs(silentRuntime(), Props),
        });
        store.sync(props, {});
        store.start();
        store.sync(clone, {});
        expect(store.getSnapshot()).toEqual({ changes: 0 });
        store.stop();
        await released(store);
      }),
      { numRuns: 200 },
    );
  });
});
