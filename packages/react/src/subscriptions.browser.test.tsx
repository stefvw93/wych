/**
 * Subscriptions through the React binding, in a real browser.
 *
 * The node suite (`subscriptions.test.ts`) drives every diff and teardown
 * rule through `createFeatureStore`. What only a mount can show is the effect
 * scheduling React owns: a props flip carried by a parent's `useState`, an
 * unmount from the tree, StrictMode's simulated remount, and a render React
 * abandons inside a transition — the four cases `subscriptions.specs.md`
 * lists under Browser coverage.
 */

import { Effect, Schema } from "effect";
import { act, StrictMode, Suspense, useState, useTransition } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createRecorder, devtoolsLayer, type DevtoolsEvent } from "./devtools";
import { Action, Command, createRuntime, define, Subscription } from "./lib";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recorder = createRecorder();
const { component } = createRuntime(devtoolsLayer(recorder.sink));

// ---------------------------------------------------------------------------
// A presence feed keyed on the room prop. The subscription logs when its body
// runs and however it ends, and — for the announcing variant — dispatches one
// `Tick` carrying the room, so the DOM shows which key is live. `Go` is a
// 50ms command, for the unmount case.
// ---------------------------------------------------------------------------

const Presence = define({
  props: Schema.Struct({ room: Schema.String }),
  state: Schema.Struct({ seen: Schema.Array(Schema.String) }),
  action: Action.of([
    Action("Tick", { id: Schema.String }),
    Action("Go", {}),
    Action("Late", { id: Schema.String }),
  ]),
});

let log: Array<string> = [];

/**
 * `announce: false` builds a feed that never dispatches, for the transition
 * case, so its log holds only what the diff did and no `Tick` re-renders the
 * committed tree while the transition is pending.
 */
const make = (name: string, announce: boolean) => {
  const feature = Presence.create({
    initialState: () => ({ seen: [] }),
    reducer: {
      Tick: ({ id }, { state }) => ({ seen: [...state.seen, id] }),
      Late: ({ id }, { state }) => ({ seen: [...state.seen, id] }),
      Go: (_action, { state }) => [
        state,
        Command.effect((dispatch) =>
          Effect.sleep("50 millis").pipe(Effect.andThen(dispatch({ _tag: "Late", id: "late" }))),
        ),
      ],
    },
    subscriptions: ({ props }) => ({
      [`room:${props.room}`]: Subscription.effect((dispatch) =>
        Effect.sync(() => void log.push(`room:${props.room}:start`)).pipe(
          Effect.andThen(announce ? dispatch({ _tag: "Tick", id: props.room }) : Effect.void),
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => void log.push(`room:${props.room}:stop`))),
        ),
      ),
    }),
    render: ({ state, dispatch }) => (
      <div>
        <span data-testid="seen">{state.seen.join(",")}</span>
        <button data-testid="go" onClick={() => dispatch({ _tag: "Go" })}>
          go
        </button>
      </div>
    ),
  });
  return component(feature, { name });
};

const PresenceView = make("Presence", true);
const QuietPresenceView = make("QuietPresence", false);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (element: React.ReactNode) => {
  recorder.clear();
  log = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
};

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  recorder.clear();
});

const text = (testId: string) =>
  container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

const click = async (testId: string) => {
  const element = container?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  await act(async () => element?.click());
};

/**
 * Let the subscription fibers a mount or a click started run, inside `act`:
 * a fork lands on the scheduler after the `act` that caused it resolves, so
 * the `Tick` it dispatches would otherwise update React outside `act`.
 */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));

const tagged = <T extends DevtoolsEvent["_tag"]>(
  tag: T,
): ReadonlyArray<Extract<DevtoolsEvent, { readonly _tag: T }>> =>
  recorder.events.filter(
    (event): event is Extract<DevtoolsEvent, { readonly _tag: T }> => event._tag === tag,
  );

const transitions = (actionTag: string) =>
  tagged("Transition").filter((event) => event.action._tag === actionTag);

/** Position of the first event matching `pick` in the recorder, or -1. */
const indexOf = (pick: (event: DevtoolsEvent) => boolean): number =>
  recorder.events.findIndex(pick);

/** Keys whose fiber has started and not yet stopped, from the log. */
const live = (): ReadonlyArray<string> => {
  const running = new Set<string>();
  for (const line of log) {
    const [, key, what] = /^(.+):(start|stop)$/.exec(line) ?? [];
    if (what === "start") running.add(key!);
    else running.delete(key!);
  }
  return [...running];
};

// ---------------------------------------------------------------------------

test("a room switch restarts under the new key, with no `Mounted` or `Unmounted` involved", async () => {
  const Parent = () => {
    const [room, setRoom] = useState("a");
    return (
      <div>
        <button data-testid="switch" onClick={() => setRoom("b")}>
          switch
        </button>
        <PresenceView room={room} />
      </div>
    );
  };

  await mount(<Parent />);
  await flush();
  expect(text("seen")).toBe("a");
  expect(live()).toEqual(["room:a"]);

  await click("switch");
  await flush();

  // The new key's fiber is emitting into the DOM on the render that carried
  // the prop, and the old key's finalizer has run.
  await vi.waitFor(() => expect(text("seen")).toBe("a,b"));
  expect(log).toEqual(["room:a:start", "room:a:stop", "room:b:start"]);
  expect(live()).toEqual(["room:b"]);

  // The diff came from `sync` folding `PropsChanged` in the render body: one
  // mount for the whole test, and nothing unmounted.
  expect(transitions("Mounted")).toHaveLength(1);
  expect(transitions("Unmounted")).toHaveLength(0);
  expect(transitions("PropsChanged")).toHaveLength(1);
  expect(
    tagged("SubscriptionStopped").map((event) => [event.key, event.reason, event.cause]),
  ).toEqual([["room:a", "Undeclared", { _tag: "Lifecycle" }]]);
  expect(tagged("SubscriptionStarted").map((event) => event.key)).toEqual(["room:a", "room:b"]);
});

test("unmount stops the subscription and lets a pending command finish", async () => {
  await mount(<PresenceView room="a" />);
  await flush();
  expect(text("seen")).toBe("a");

  await click("go");
  await act(async () => root!.unmount());
  root = undefined;

  // The subscription is gone before the `Unmounted` transition is reported;
  // the command it left behind still finishes, and what it emits folds into
  // the store — which no longer paints, but still reports.
  await vi.waitFor(() => expect(transitions("Late")).toHaveLength(1));

  const stopped = indexOf(
    (event) => event._tag === "SubscriptionStopped" && event.reason === "Unmounted",
  );
  const unmounted = indexOf(
    (event) => event._tag === "Transition" && event.action._tag === "Unmounted",
  );
  const late = indexOf((event) => event._tag === "Transition" && event.action._tag === "Late");

  expect(stopped).toBeGreaterThan(-1);
  expect(stopped).toBeLessThan(unmounted);
  expect(unmounted).toBeLessThan(late);
  expect(transitions("Late")[0]!.cause).toEqual({ _tag: "Command", action: "Go" });
  expect(log).toEqual(["room:a:start", "room:a:stop"]);
});

test("StrictMode's double mount starts exactly one subscription per key on the surviving mount", async () => {
  await mount(
    <StrictMode>
      <PresenceView room="a" />
    </StrictMode>,
  );
  await flush();
  expect(text("seen")).toContain("a");

  // Effect, cleanup, effect: the first mount's key is declared and undeclared
  // by its own `stop()`, the second mount's key is declared once. The events
  // describe the declared set, so the first mount shows a `Started` and a
  // `Stopped` whether or not its fiber ever ran.
  await vi.waitFor(() => expect(live()).toEqual(["room:a"]));
  expect(tagged("SubscriptionStarted").map((event) => event.key)).toEqual(["room:a", "room:a"]);
  expect(tagged("SubscriptionStopped").map((event) => event.reason)).toEqual(["Unmounted"]);

  // One store, one instance, across the simulated remount.
  expect(new Set(recorder.events.map((event) => event.instance)).size).toBe(1);
});

test("a discarded render never declares its subscription", async () => {
  // A transition to room `b` renders the feature with `b` and then suspends
  // on a sibling that never resolves, so React keeps the committed `a` on
  // screen and abandons the render. The render body touches nothing in the
  // store, and the layout effect that folds `PropsChanged` never runs for a
  // render that does not commit, so `room:b` is never started. The
  // synchronous update back to `a` commits props equal to the baseline and
  // folds nothing either.
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
          <QuietPresenceView room={room} />
          <Suspender room={room} />
        </Suspense>
      </div>
    );
  };

  await mount(<Parent />);
  await vi.waitFor(() => expect(live()).toEqual(["room:a"]));

  await click("to-b");
  await flush();

  // The transition never commits: `a` stays on screen, no fallback shows,
  // and the store never heard of `b`.
  expect(live()).toEqual(["room:a"]);
  expect(text("room")).toBe("a");
  expect(container?.querySelector('[data-testid="fallback"]')).toBeNull();
  expect(transitions("PropsChanged")).toHaveLength(0);

  await click("to-a");
  await flush();

  expect(live()).toEqual(["room:a"]);
  expect(text("room")).toBe("a");
  expect(log).toEqual(["room:a:start"]);
  expect(transitions("PropsChanged")).toHaveLength(0);
  expect(tagged("SubscriptionStarted").map((event) => event.key)).toEqual(["room:a"]);
  expect(tagged("SubscriptionStopped")).toHaveLength(0);
  expect(transitions("Mounted")).toHaveLength(1);
  expect(transitions("Unmounted")).toHaveLength(0);
});
