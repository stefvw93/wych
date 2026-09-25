/**
 * Shared fixtures for the `bench` and `stress` Vitest projects.
 *
 * Nothing here ships: `src/__fixtures__` is outside the pack entry. The
 * probes read the `@wych/internals` slot the store and runtime carry, the
 * way the internals test in `lib.test.ts` does, so no named export of the
 * library exists for them.
 */
import process from "node:process";
import v8 from "node:v8";
import vm from "node:vm";
import { Effect, Equivalence, Layer, ManagedRuntime, Schema } from "effect";
import { createRecorder, devtoolsLayer } from "../devtools";
import { Action, Command, createFeatureStore, define, Subscription } from "../lib";
import { query } from "./devtools";
import { idle, probe, type StoreProbe } from "./probe";

export * from "./probe";

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

/** Multiplier for every count in the stress suites. `STRESS_SCALE=4` for a headroom run. */
export const SCALE = Math.max(1, Number(process.env.STRESS_SCALE ?? "1") || 1);

/** `n` at scale 1, scaled. */
export const at = (n: number): number => Math.round(n * SCALE);

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/** One macrotask, so forked fibers and finalizers get to run. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Poll until `predicate` holds, one macrotask between polls. Throws after
 * `timeoutMs` with the last probe in the message, so a failure names the
 * counter that did not settle.
 */
export const until = async (
  store: object,
  predicate: (p: StoreProbe) => boolean,
  timeoutMs = 10_000,
): Promise<StoreProbe> => {
  const deadline = Date.now() + timeoutMs;
  let last = probe(store);
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(`store did not settle within ${timeoutMs}ms: ${JSON.stringify(last)}`);
    }
    await tick();
    last = probe(store);
  }
  return last;
};

/**
 * `until` on `setImmediate` instead of a timer: a timer's 1ms floor would be
 * the whole measurement in a benchmark. Node only, which the `bench` and
 * `stress` projects are.
 */
export const spin = async (
  store: object,
  predicate: (p: StoreProbe) => boolean,
  maxSpins = 1_000_000,
): Promise<StoreProbe> => {
  let last = probe(store);
  for (let i = 0; !predicate(last); i++) {
    if (i > maxSpins) throw new Error(`store did not settle: ${JSON.stringify(last)}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = probe(store);
  }
  return last;
};

/** Command quiescence: nothing queued for the mount, nothing in flight, nothing waiting to fold. */
export const quiescent = (p: StoreProbe): boolean =>
  p.queued === 0 && p.inFlight === 0 && p.pending === 0;

/** `spin` to command quiescence. */
export const spinSettle = (store: object): Promise<StoreProbe> => spin(store, quiescent);

/** Command quiescence: no fiber in flight and nothing waiting to fold. */
export const settle = (store: object, timeoutMs?: number): Promise<StoreProbe> =>
  until(store, quiescent, timeoutMs);

/** After `stop()`: the mount released and every book empty. */
export const released = (store: object, timeoutMs?: number): Promise<StoreProbe> =>
  until(store, (p) => !p.mounted && idle(p), timeoutMs);

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const gc: () => void = (() => {
  const own = (globalThis as { gc?: () => void }).gc;
  if (typeof own === "function") return own;
  // Outside the `stress` project (`vp test --project node -t …`) `--expose-gc`
  // is not set; V8 still honours the flag for a fresh context.
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc") as () => void;
})();

/**
 * Collect twice, let finalizers and fiber observers run, collect again, and
 * read the heap. The macrotask is what lets a `FinalizationRegistry` callback
 * and a fiber's last observer fire before the reading.
 */
export const settleHeap = async (): Promise<number> => {
  gc();
  gc();
  await tick();
  gc();
  return process.memoryUsage().heapUsed;
};

/** How many of the `refs` are still alive after a settled collection. */
export const alive = (refs: ReadonlyArray<WeakRef<object>>): number =>
  refs.reduce((n, ref) => (ref.deref() === undefined ? n : n + 1), 0);

/** Least-squares slope of `samples` per index: bytes per round. */
export const slope = (samples: ReadonlyArray<number>): number => {
  const n = samples.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = samples.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  samples.forEach((y, x) => {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  });
  return num / den;
};

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** A root runtime with a recorder installed. */
export const recordingRuntime = <R = never, E = never>(extra?: Layer.Layer<R, E>) => {
  const recorder = createRecorder();
  const sink = devtoolsLayer(recorder.sink);
  const runtime = ManagedRuntime.make(extra === undefined ? sink : Layer.mergeAll(sink, extra));
  return { runtime, recorder, ...query(recorder) };
};

/** A bare root runtime, no sink. */
export const silentRuntime = () => ManagedRuntime.make(Layer.empty);

export const hooksEquivalence = Equivalence.Record(Equivalence.strictEqual<unknown>());

/** The `createFeatureStore` arguments every fixture shares, minus the feature and props. */
export const storeArgs = (
  runtime: ManagedRuntime.ManagedRuntime<never, unknown>,
  propsSchema: Schema.Struct<any>,
  overrides: {
    readonly layer?: Layer.Layer<any, any, any>;
    readonly emit?: (output: { readonly _tag: string }) => void;
    readonly defect?: (error: unknown) => void;
    readonly name?: string;
  } = {},
) => ({
  runtime,
  layer: overrides.layer,
  equivalence: { props: Schema.toEquivalence(propsSchema), hooks: hooksEquivalence },
  emit: overrides.emit ?? (() => {}),
  defect:
    overrides.defect ??
    ((error: unknown) => {
      throw error;
    }),
  name: overrides.name ?? "Stress",
});

// ---------------------------------------------------------------------------
// Counter: the smallest feature. `Bump` moves state, `Same` returns the same
// reference, `Noop` returns state with `Command.none`.
// ---------------------------------------------------------------------------

export const CounterProps = Schema.Struct({ id: Schema.String });
export const CounterState = Schema.Struct({ count: Schema.Number });
export const Bump = Action("Bump", {});
export const Same = Action("Same", {});
export const Noop = Action("Noop", {});

export const counter = define({
  props: CounterProps,
  state: CounterState,
  action: [Bump, Same, Noop],
}).create({
  initialState: () => ({ count: 0 }),
  reducer: {
    Bump: (_a, { state }) => ({ count: state.count + 1 }),
    Same: (_a, { state }) => state,
    Noop: (_a, { state }) => [state, Command.none],
  },
  render: () => null,
});

export const counterStore = (
  runtime: ManagedRuntime.ManagedRuntime<never, unknown>,
  overrides: Parameters<typeof storeArgs>[2] = {},
) =>
  createFeatureStore({
    feature: counter,
    props: { id: "c" },
    ...storeArgs(runtime, CounterProps, overrides),
  });

// ---------------------------------------------------------------------------
// Restarter: one keyed leaf per `Go`, take-latest under one name. `Kill`
// cancels it. The leaf is `Effect.never` unless `finalizerMs` is set, in
// which case it is `Effect.never` with a sleeping finalizer.
// ---------------------------------------------------------------------------

export const RestartProps = Schema.Struct({});
export const RestartState = Schema.Struct({ issued: Schema.Number, errors: Schema.Number });
export const Go = Action("Go", {});
export const Kill = Action("Kill", {});

export const restarter = (options: { readonly finalizerMs?: number } = {}) => {
  const ms = options.finalizerMs;
  const leaf =
    ms === undefined
      ? Command.effect(() => Effect.never)
      : Command.effect(() => Effect.never.pipe(Effect.ensuring(Effect.sleep(ms))));
  return define({
    props: RestartProps,
    state: RestartState,
    action: [Go, Kill],
  }).create({
    initialState: () => ({ issued: 0, errors: 0 }),
    reducer: {
      Go: (_a, { state }) => [
        { ...state, issued: state.issued + 1 },
        Command.restart("work", leaf),
      ],
      Kill: (_a, { state }) => [state, Command.cancel("work")],
      Error: (_a, { state }) => ({ ...state, errors: state.errors + 1 }),
    },
    render: () => null,
  });
};

// ---------------------------------------------------------------------------
// Presence: `keys` in state name the subscriptions the feature declares. Each
// key's effect is `Effect.never` (a listener that only holds), or a stream
// stub when `emit` is given. `Tick` collects what the sources dispatch.
// ---------------------------------------------------------------------------

export const PresenceProps = Schema.Struct({ room: Schema.String });
export const PresenceState = Schema.Struct({
  keys: Schema.Array(Schema.String),
  seen: Schema.Number,
  errors: Schema.Number,
});
export const Declare = Action("Declare", { keys: Schema.Array(Schema.String) });
export const Tick = Action("Tick", { key: Schema.String, n: Schema.Number });

export type PresenceSnapshot = {
  readonly state: {
    readonly keys: ReadonlyArray<string>;
    readonly seen: number;
    readonly errors: number;
  };
  readonly props: { readonly room: string };
  readonly hooks: {};
};

export const presence = (
  source: (key: string, dispatch: (a: any) => Effect.Effect<void>) => Effect.Effect<unknown>,
) =>
  define({
    props: PresenceProps,
    state: PresenceState,
    action: [Declare, Tick],
  }).create({
    initialState: () => ({ keys: [], seen: 0, errors: 0 }),
    reducer: {
      Declare: ({ keys }, { state }) => ({ ...state, keys }),
      Tick: (_a, { state }) => ({ ...state, seen: state.seen + 1 }),
      Error: (_a, { state }) => ({ ...state, errors: state.errors + 1 }),
    },
    subscriptions: ({ state }: PresenceSnapshot) =>
      Object.fromEntries(
        state.keys.map((key) => [key, Subscription.effect((dispatch) => source(key, dispatch))]),
      ),
    render: () => null,
  });

/** `n` keys named `k0…k{n-1}`. */
export const keys = (n: number): ReadonlyArray<string> =>
  Array.from({ length: n }, (_, i) => `k${i}`);

// ---------------------------------------------------------------------------
// Burst: `Fire` issues a command that dispatches `Hit` `n` times synchronously
// inside one `Effect.sync`; `Count` is what a burst leaves behind.
// ---------------------------------------------------------------------------

export const BurstProps = Schema.Struct({});
export const BurstState = Schema.Struct({ hits: Schema.Number, errors: Schema.Number });
export const Fire = Action("Fire", { n: Schema.Number });
export const Hit = Action("Hit", { i: Schema.Number });

export const burst = define({
  props: BurstProps,
  state: BurstState,
  action: [Fire, Hit],
}).create({
  initialState: () => ({ hits: 0, errors: 0 }),
  reducer: {
    Fire: ({ n }, { state }) => [
      state,
      Command.effect((dispatch) =>
        Effect.gen(function* () {
          for (let i = 0; i < n; i++) yield* dispatch(Hit.make({ i }));
        }),
      ),
    ],
    Hit: (_a, { state }) => ({ ...state, hits: state.hits + 1 }),
    Error: (_a, { state }) => ({ ...state, errors: state.errors + 1 }),
  },
  render: () => null,
});
