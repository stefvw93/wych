/**
 * Core runtime benchmarks. `vp run bench` from `packages/react`; numbers and
 * the seam each one drives are in `lib.specs.md` "Performance and resilience".
 */
import { Context, Effect, Layer, Schema, SchemaParser } from "effect";
import { bench, describe } from "vite-plus/test";
import {
  Bump,
  burst,
  BurstProps,
  counter,
  counterStore,
  Fire,
  Go,
  Kill,
  restarter,
  RestartProps,
  silentRuntime,
  spin,
  spinSettle,
  storeArgs,
} from "./__fixtures__/stress";
import { Action, Command, createFeatureStore, define } from "./lib";

const runtime = silentRuntime();

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

describe("fold", () => {
  const store = counterStore(runtime);
  store.subscribe(() => {});
  store.start();
  const action = Bump.make({});

  bench("dispatch: no sink, no hook", () => {
    store.dispatch(action);
  });
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

describe("commands", () => {
  const leafStore = createFeatureStore({
    feature: burst,
    props: {},
    ...storeArgs(runtime, BurstProps),
  });
  leafStore.start();
  const noEmit = Fire.make({ n: 0 });

  bench("Command.effect: fork one leaf and settle", async () => {
    leafStore.dispatch(noEmit);
    await spinSettle(leafStore);
  });

  const Many = Action("Many", { m: Schema.Number });
  const batcher = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ n: Schema.Number }),
    action: Action.of([Many]),
  }).create({
    initialState: () => ({ n: 0 }),
    reducer: {
      Many: ({ m }, { state }) => [
        state,
        Command.batch(...Array.from({ length: m }, () => Command.effect(() => Effect.void))),
      ],
    },
    render: () => null,
  });
  const batchStore = createFeatureStore({
    feature: batcher,
    props: {},
    ...storeArgs(runtime, Schema.Struct({})),
  });
  batchStore.start();

  for (const m of [1, 10, 100]) {
    const action = Many.make({ m });
    bench(`Command.batch: ${m} leaves and settle`, async () => {
      batchStore.dispatch(action);
      await spinSettle(batchStore);
    });
  }

  const restartStore = createFeatureStore({
    feature: restarter(),
    props: {},
    ...storeArgs(runtime, RestartProps),
  });
  restartStore.start();
  const go = Go.make({});
  const kill = Kill.make({});

  bench("Command.restart: 100 dispatches into one key, then cancel", async () => {
    for (let i = 0; i < 100; i++) restartStore.dispatch(go);
    restartStore.dispatch(kill);
    await spinSettle(restartStore);
  });
});

// ---------------------------------------------------------------------------
// Feature.run
// ---------------------------------------------------------------------------

describe("Feature.run", () => {
  const seeds = Array.from({ length: 10_000 }, () => Bump.make({}));
  const options = { props: { id: "run" }, hooks: {}, layer: Layer.empty };

  bench("10k seeds, no commands", async () => {
    await Effect.runPromise(counter.run(seeds, options));
  });

  const Ping = Action("Ping", {});
  const Pong = Action("Pong", {});
  const echo = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ pongs: Schema.Number }),
    action: Action.of([Ping, Pong]),
  }).create({
    initialState: () => ({ pongs: 0 }),
    reducer: {
      Ping: (_a, { state }) => [state, Command.effect((dispatch) => dispatch(Pong.make({})))],
      Pong: (_a, { state }) => ({ pongs: state.pongs + 1 }),
    },
    render: () => null,
  });
  const pings = Array.from({ length: 10_000 }, () => Ping.make({}));

  bench("10k seeds, each emits one action", async () => {
    await Effect.runPromise(echo.run(pings, { props: {}, hooks: {}, layer: Layer.empty }));
  });
});

// ---------------------------------------------------------------------------
// Props: what every render pays
// ---------------------------------------------------------------------------

const propsOf = (fields: number) =>
  Schema.Struct(
    Object.fromEntries(Array.from({ length: fields }, (_, i) => [`f${i}`, Schema.Number])),
  );

const valueOf = (fields: number): Record<string, number> =>
  Object.fromEntries(Array.from({ length: fields }, (_, i) => [`f${i}`, i]));

describe("props", () => {
  for (const fields of [3, 30, 300]) {
    const schema = propsOf(fields);
    const equivalence = Schema.toEquivalence(schema);
    const validate = SchemaParser.decodeUnknownSync(schema, {
      onExcessProperty: "error",
      errors: "all",
    });
    const a = valueOf(fields);
    const b = valueOf(fields);

    bench(`Schema.toEquivalence: ${fields} fields, equal by value`, () => {
      equivalence(a, b);
    });

    bench(`decodeUnknownSync: ${fields} fields`, () => {
      validate(a);
    });
  }

  const Props30 = propsOf(30);
  const Tock = Action("Tock", {});
  const wide = define({
    props: Props30,
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
  const same = valueOf(30);
  const store = createFeatureStore({
    feature: wide,
    props: same,
    ...storeArgs(runtime, Props30),
  });
  store.sync(same, {});
  store.start();

  // Prebuilt, so the props object's construction is not in the timed body.
  const equal = Array.from({ length: 1024 }, () => valueOf(30));
  const changed = Array.from({ length: 1024 }, (_, i) => ({ ...same, f0: 1000 + i }));
  let i = 0;

  bench("store.sync: 30 fields, equal props", () => {
    store.sync(equal[i++ & 1023]!, {});
  });

  bench("store.sync: 30 fields, one field changed", () => {
    store.sync(changed[i++ & 1023]!, {});
  });
});

// ---------------------------------------------------------------------------
// Mount cycle
// ---------------------------------------------------------------------------

class Svc extends Context.Service<Svc, { readonly n: number }>()("BenchSvc") {}

describe("mount cycle", () => {
  const layers: ReadonlyArray<readonly [string, Layer.Layer<any, any, any> | undefined]> = [
    ["no layer", undefined],
    ["Layer.succeed", Layer.succeed(Svc)({ n: 1 })],
    ["async Layer.effect", Layer.effect(Svc)(Effect.yieldNow.pipe(Effect.as({ n: 1 })))],
  ];

  for (const [label, layer] of layers) {
    bench(`createFeatureStore + start + stop: ${label}`, async () => {
      const store = counterStore(runtime, { layer });
      store.start();
      store.stop();
      await spin(store, (p) => !p.mounted);
    });
  }
});
