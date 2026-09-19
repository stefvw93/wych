/**
 * Subscription diff benchmarks: what a fold pays for a hook that declares K
 * keys, and what one key change costs. `lib.specs.md` "Performance and
 * resilience" carries the numbers.
 */
import { Effect } from "effect";
import { bench, describe } from "vite-plus/test";
import {
  Declare,
  keys,
  presence,
  PresenceProps,
  silentRuntime,
  spin,
  storeArgs,
  Tick,
} from "./__fixtures__/stress";
import { createFeatureStore } from "./lib";

const runtime = silentRuntime();

/** A listener that only holds: the diff, not the source, is the subject. */
const holding = presence(() => Effect.never);

const storeWith = (declared: ReadonlyArray<string>) => {
  const store = createFeatureStore({
    feature: holding,
    props: { room: "bench" },
    ...storeArgs(runtime, PresenceProps),
  });
  store.start();
  store.dispatch(Declare.make({ keys: declared }));
  return store;
};

describe("reconcile", () => {
  const tick = Tick.make({ key: "bench", n: 0 });

  for (const k of [1, 10, 100]) {
    const store = storeWith(keys(k));

    bench(`fold with ${k} stable keys: hook evaluated, nothing changes`, () => {
      store.dispatch(tick);
    });
  }

  for (const k of [10, 100]) {
    const stable = keys(k - 1);
    const store = storeWith([...stable, "rotating:0"]);
    let i = 0;

    bench(`${k} keys, one rotates: stop one, start one, settle`, async () => {
      i += 1;
      const rotating = `rotating:${i}`;
      store.dispatch(Declare.make({ keys: [...stable, rotating] }));
      // The stop is awaited on the mount fiber before the start is forked, so
      // the book is back at `k` only once both halves of the diff have run.
      await spin(store, (p) => p.subscriptions === k && p.declared === k);
    });
  }
});
