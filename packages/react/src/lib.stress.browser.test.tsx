/**
 * Stress for the React binding, in Chromium: many sibling mounts, StrictMode
 * at scale, a long mount/unmount session, and discarded renders with an
 * emitting subscription. `vp run stress:browser` from `packages/react`.
 *
 * Numbers this file prints (`console.info`) are indicative and land in
 * `lib.specs.md` "Performance and resilience" with a machine caveat.
 */
import { Effect, Schema } from "effect";
import { Component, Profiler, StrictMode, Suspense, useState, useTransition } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { query } from "./__fixtures__/devtools";
import { click, container, mount, unmount } from "./__fixtures__/dom";
import { contexts, MiB } from "./__fixtures__/probe";
import { createRecorder, devtoolsLayer } from "./devtools";
import { Action, createRuntime, define, Subscription } from "./lib";

const recorder = createRecorder();
const runtime = createRuntime(devtoolsLayer(recorder.sink));
const { component } = runtime;
const { tagged, transitions } = query(recorder);

/** Chromium with `--enable-precise-memory-info`; absent elsewhere. */
const heapUsed = (): number | undefined =>
  (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
const gc = (): void => (globalThis as { gc?: () => void }).gc?.();

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

const Bump = Action("Bump", {});

const Counter = define({
  props: Schema.Struct({ id: Schema.Number }),
  state: Schema.Struct({ count: Schema.Number }),
  action: [Bump],
});

const counter = Counter.create({
  initialState: () => ({ count: 0 }),
  reducer: { Bump: (_a, { state }) => ({ count: state.count + 1 }) },
  render: ({ state, props, dispatch }) => (
    <button data-testid={`c${props.id}`} onClick={() => dispatch(Bump.make({}))}>
      {state.count}
    </button>
  ),
});

const CounterView = component(counter, { name: "StressCounter" });
const CounterA = component(counter, { name: "StressA" });
const CounterB = component(counter, { name: "StressB" });
const CounterC = component(counter, { name: "StressC" });

const Tick = Action("Tick", {});

const Presence = define({
  props: Schema.Struct({ room: Schema.String, id: Schema.Number }),
  state: Schema.Struct({ ticks: Schema.Number }),
  action: [Tick],
});

/** One key per room. `emit` makes it tick every few milliseconds. */
const presence = (emit: boolean) =>
  Presence.create({
    initialState: () => ({ ticks: 0 }),
    reducer: { Tick: (_a, { state }) => ({ ticks: state.ticks + 1 }) },
    subscriptions: ({ props }) => ({
      [`room:${props.room}`]: Subscription.effect((dispatch) =>
        emit
          ? Effect.forever(Effect.sleep(5).pipe(Effect.andThen(dispatch(Tick.make({})))))
          : Effect.never,
      ),
    }),
    render: ({ state, props }) => (
      <span data-testid={`p${props.id}`}>
        {props.room}:{state.ticks}
      </span>
    ),
  });

const QuietPresence = component(presence(false), { name: "StressQuietPresence" });
const LoudPresence = component(presence(true), { name: "StressLoudPresence" });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Unmount first, so the `Unmounted` events land before the clear: vitest runs
// after hooks in reverse order, and the fixture registered its own first.
afterEach(async () => {
  await unmount();
  recorder.clear();
});

type Commit = { readonly phase: string; readonly actualDuration: number };

const profiled = (children: React.ReactNode, commits: Array<Commit>) => (
  <Profiler
    id="grid"
    onRender={(_id, phase, actualDuration) => void commits.push({ phase, actualDuration })}
  >
    {children}
  </Profiler>
);

const sum = (commits: ReadonlyArray<Commit>) =>
  commits.reduce((total, c) => total + c.actualDuration, 0);

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

// React's development build defines a non-enumerable `key` getter on the
// props of a keyed element, to warn on access. The props decoder reads own
// property names, so `splitOutputProps` copies such an object through
// `Object.keys` instead of passing it through. The grids below put the key on
// the feature itself.
test("a feature rendered with a key passes props validation", async () => {
  let thrown: unknown;
  class Boundary extends Component<
    { readonly children: React.ReactNode },
    { readonly failed: boolean }
  > {
    override state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    override componentDidCatch(error: unknown) {
      thrown = error;
    }
    override render() {
      return this.state.failed ? null : this.props.children;
    }
  }
  await mount(
    <Boundary>
      {[1, 2, 3].map((i) => (
        <CounterView key={i} id={i} />
      ))}
    </Boundary>,
  );
  expect(thrown).toBeUndefined();
  expect(container().querySelectorAll("button")).toHaveLength(3);
});

// ---------------------------------------------------------------------------
// Many mounts
// ---------------------------------------------------------------------------

test("250 sibling features mount in one commit, paint, and unmount clean", async () => {
  const n = 250;
  const commits: Array<Commit> = [];
  const grid = Array.from({ length: n }, (_, i) => <CounterView key={i} id={i} />);

  const started = performance.now();
  await mount(profiled(grid, commits));
  const wall = performance.now() - started;

  // One commit for the tree; `useSyncExternalStore` may schedule one catch-up.
  expect(commits.length).toBeLessThanOrEqual(2);
  expect(container().querySelectorAll("button")).toHaveLength(n);
  expect(container().querySelector('[data-testid="c249"]')!.textContent).toBe("0");
  await vi.waitFor(() => expect(transitions("Mounted")).toHaveLength(n));

  // A dispatch in one child is one commit, and repaints only that child.
  commits.length = 0;
  await click("c7");
  expect(commits.length).toBeLessThanOrEqual(2);
  expect(container().querySelector('[data-testid="c7"]')!.textContent).toBe("1");
  expect(container().querySelector('[data-testid="c8"]')!.textContent).toBe("0");

  console.info(
    `[stress] 250 siblings: mount ${wall.toFixed(1)}ms wall, ${sum(commits).toFixed(1)}ms in the dispatch commit`,
  );

  await unmount();
  expect(document.body.querySelectorAll("button")).toHaveLength(0);
  await vi.waitFor(() => expect(transitions("Unmounted")).toHaveLength(n));
});

test("1000 sibling features: a probe, reported not gated", async () => {
  const n = 1000;
  const commits: Array<Commit> = [];
  const grid = Array.from({ length: n }, (_, i) => <CounterView key={i} id={i} />);

  const started = performance.now();
  await mount(profiled(grid, commits));
  const wall = performance.now() - started;

  expect(container().querySelectorAll("button")).toHaveLength(n);
  await vi.waitFor(() => expect(transitions("Mounted")).toHaveLength(n));
  console.info(
    `[stress] 1000 siblings: mount ${wall.toFixed(1)}ms wall, ${sum(commits).toFixed(1)}ms render across ${commits.length} commit(s)`,
  );
});

test("250 subscribing features under StrictMode double-mount and settle to one key each", async () => {
  const n = 250;
  const grid = Array.from({ length: n }, (_, i) => <QuietPresence key={i} id={i} room={`r${i}`} />);
  await mount(<StrictMode>{grid}</StrictMode>);

  // Effect, cleanup, effect: two `Mounted` per feature, one `Unmounted` from
  // the simulated unmount, and the first mount's key stopped by it.
  await vi.waitFor(() => expect(transitions("Mounted")).toHaveLength(2 * n));
  await vi.waitFor(() => expect(transitions("Unmounted")).toHaveLength(n));
  await vi.waitFor(() => expect(tagged("SubscriptionStarted")).toHaveLength(2 * n));
  const stoppedAtMount = tagged("SubscriptionStopped");
  expect(stoppedAtMount).toHaveLength(n);
  expect(stoppedAtMount.every((e) => e.reason === "Unmounted")).toBe(true);
  expect(tagged("Defect")).toHaveLength(0);

  await unmount();
  await vi.waitFor(() => expect(tagged("SubscriptionStopped")).toHaveLength(2 * n));
  expect(tagged("SubscriptionStopped").some((e) => e.reason === "Died")).toBe(false);
  expect(transitions("Unmounted")).toHaveLength(2 * n);
});

// ---------------------------------------------------------------------------
// Long sessions
// ---------------------------------------------------------------------------

test("2000 mount/unmount cycles under three names keep three contexts and a flat heap", async () => {
  const cycles = 2000;
  const rounds = 8;
  const perRound = cycles / rounds;
  const before = contexts(runtime);
  let mounted = 0;
  let unmounted = 0;
  const heap: Array<number> = [];

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < perRound; i++) {
      await mount(
        <>
          <CounterA id={1} />
          <CounterB id={2} />
          <CounterC id={3} />
        </>,
      );
      await click("c1");
      await unmount();
    }
    await vi.waitFor(() => {
      expect(transitions("Unmounted")).toHaveLength(3 * perRound);
    });
    mounted += transitions("Mounted").length;
    unmounted += transitions("Unmounted").length;
    // The recorder is the one thing that would grow; it is not the subject.
    recorder.clear();
    gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
    gc();
    const used = heapUsed();
    if (used !== undefined) heap.push(used);
  }

  expect(mounted).toBe(3 * cycles);
  expect(unmounted).toBe(3 * cycles);
  // `component()` made the contexts, before the loop; mounting makes none.
  expect(contexts(runtime)).toBe(before);

  if (heap.length === rounds) {
    const tail = heap.slice(-5);
    const growth = tail[tail.length - 1] - tail[0];
    console.info(
      `[stress] 2000 cycles: heap ${heap.map((h) => (h / MiB).toFixed(1)).join(" → ")} MiB`,
    );
    expect(growth).toBeLessThan(2 * MiB);
  }
});

// ---------------------------------------------------------------------------
// Discarded renders
// ---------------------------------------------------------------------------

// lib.specs.md "Deferred decisions", `store.sync` folding during render:
// executed. The render body touches nothing in the store and the fold runs in
// a layout effect, so a render React abandons never starts the key it would
// have declared, however long it is held and however often the committed key
// emits meanwhile. Before the redesign this measured 1, 3, 7 and 18 restarts
// of the discarded key for holds of 0, 12, 50 and 150 ms with a 5 ms tick:
// each emission forced a sync re-render whose render-body `sync` re-folded
// the discarded props.
test("50 abandoned transitions held 50ms with an emitting subscription never start the discarded key", async () => {
  const attempts = 50;
  const pending = new Promise<never>(() => {});
  const Suspender = ({ room }: { readonly room: string }) => {
    if (room === "b") throw pending;
    return null;
  };

  const Parent = () => {
    const [room, setRoom] = useState("a");
    const [, startTransition] = useTransition();
    return (
      <div>
        <button data-testid="to-b" onClick={() => startTransition(() => setRoom("b"))}>
          to b
        </button>
        <button data-testid="to-a" onClick={() => setRoom("a")}>
          to a
        </button>
        <span data-testid="room">{room}</span>
        <Suspense fallback={<span data-testid="fallback" />}>
          <LoudPresence id={0} room={room} />
          <Suspender room={room} />
        </Suspense>
      </div>
    );
  };

  await mount(<Parent />);
  await vi.waitFor(() =>
    expect(tagged("SubscriptionStarted").map((e) => e.key)).toEqual(["room:a"]),
  );

  const startsOfB = () => tagged("SubscriptionStarted").filter((e) => e.key === "room:b").length;
  const ticks = () => transitions("Tick").length;

  let fewestTicks = Number.POSITIVE_INFINITY;
  for (let i = 0; i < attempts; i++) {
    const before = ticks();
    await click("to-b");
    // Hold the abandoned render long enough for several emissions, each of
    // which re-renders the committed tree on the sync lane.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await click("to-a");
    await vi.waitFor(() =>
      expect(container().querySelector('[data-testid="room"]')!.textContent).toBe("a"),
    );
    fewestTicks = Math.min(fewestTicks, ticks() - before);
  }

  console.info(
    `[stress] abandoned transitions: room:b starts ${startsOfB()}, fewest ticks through a hold ${fewestTicks}`,
  );
  expect(container().querySelector('[data-testid="room"]')!.textContent).toBe("a");
  expect(tagged("Defect")).toHaveLength(0);
  // The discarded key never starts, the committed key is never interrupted,
  // and its feed kept emitting through every hold.
  expect(startsOfB()).toBe(0);
  expect(tagged("SubscriptionStopped")).toHaveLength(0);
  expect(fewestTicks).toBeGreaterThan(0);
});
