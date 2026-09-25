/**
 * Property tests over the runtime, with `Arbitrary` from
 * `effect/unstable/arbitrary`. Generators derive from the action schemas, so
 * a payload bound is a schema check; `check` below runs a property to 200
 * runs, shrinks the first falsification, and rethrows the failing assertion
 * with the shrunk input and a replay token in front of it.
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
import { Arbitrary } from "effect/unstable/arbitrary";
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

/** An integer in `[min, max]`: the payload bound is the schema, so `Arbitrary.schema` honours it. */
const int = (min: number, max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));

const Inc = Action("Inc", {});
const Dec = Action("Dec", {});
const Echo = Action("Echo", { n: int(0, 99) });
const Echoed = Action("Echoed", { n: Schema.Number });
const Twice = Action("Twice", {});
const Restart = Action("Restart", { k: int(0, 9) });
const Cancel = Action("Cancel", {});

const State = Schema.Struct({ n: Schema.Number, log: Schema.Array(Schema.Number) });

const differential = define({
  props: Schema.Struct({}),
  state: State,
  action: [Inc, Dec, Echo, Echoed, Twice, Restart, Cancel],
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

/** Commands that complete before the next action is reduced. */
const Settling = Schema.Union([Inc, Dec, Echo, Twice]);

/** Commands that suspend once, and the cancel that can reach them. */
const Suspending = Schema.Union([Restart, Cancel]);

const settling: Arbitrary.Arbitrary<Msg> = Arbitrary.schema(Settling);
const any: Arbitrary.Arbitrary<Msg> = Arbitrary.schema(Schema.Union([Settling, Suspending]));

const sequence = (arb: Arbitrary.Arbitrary<Msg>) => Arbitrary.array(arb, { maxLength: 50 });

/**
 * Run `property` against `runs` generated values. A throwing `expect` is a
 * typed property failure, so the runner shrinks it; the rethrow carries the
 * shrunk input and the replay token ahead of the original assertion message.
 */
const check = async <A>(
  arb: Arbitrary.Arbitrary<A>,
  property: (value: A) => Promise<void>,
  runs: number,
): Promise<void> => {
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(
      arb,
      (value) =>
        Effect.tryPromise({
          try: () => property(value).then(() => true),
          catch: (error) => error,
        }),
      { runs },
    ),
  );
  if (result._tag === "Passed") return;
  const summary = Arbitrary.formatCheckFailure(result) ?? result._tag;
  if (result._tag === "Falsified" && result.failure._tag === "PropertyError") {
    const cause = result.failure.error;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${summary}\n${message}`, { cause });
  }
  throw new Error(summary);
};

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
    await check(
      sequence(settling),
      async (actions) => {
        const [ran, stored] = await Promise.all([viaRun(actions), viaStore(actions)]);
        expect(stored.state).toEqual(ran.state);
        expect(stored.emitted).toEqual(ran.emitted);
        expect(idle(stored.probe)).toBe(true);
      },
      200,
    );
  });
});

describe("invariants", () => {
  it("after any sequence and stop(), every book is empty and the log matches what was emitted", async () => {
    await check(
      sequence(any),
      async (actions) => {
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
      },
      200,
    );
  });

  it("restart never leaves two fibers booked under one key after a macrotask", async () => {
    await check(
      Arbitrary.schema(int(1, 200)),
      async (n) => {
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
      },
      25,
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
      action: [Tock],
    }).create({
      initialState: () => ({ changes: 0 }),
      reducer: {
        Tock: (_a, { state }) => state,
        PropsChanged: (_a, { state }) => ({ changes: state.changes + 1 }),
      },
      render: () => null,
    });
    // NaN is the one number `structuredClone` preserves and equivalence cannot
    // see as equal to itself, so props are finite by schema.
    const arb = Arbitrary.schema(Schema.Struct({ ...Props.fields, count: Schema.Finite }));

    await check(
      arb,
      async (props) => {
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
      },
      200,
    );
  });
});
