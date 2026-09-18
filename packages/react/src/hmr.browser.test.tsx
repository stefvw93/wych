/**
 * Fast Refresh over a feature, in a real browser.
 *
 * Vite re-evaluates a saved module and hands React's refresh runtime the new
 * component functions; React then re-renders the fibers of the old ones with
 * the new code and keeps their hooks. Re-evaluating the module that calls
 * `component()` therefore has to yield a component whose `useFeature` reads
 * the same context as the first call's, whichever side the refresh swaps:
 * the context is looked up by `name` in a registry inside `lib.ts`, which no
 * app-file save re-evaluates.
 *
 * Each test models one module layout by hand: a function stands for one
 * evaluation of a file, `RefreshRuntime.register` stands for the registration
 * the Babel plugin emits, `$RefreshReg$` on the global stands for the hook a
 * Babel-based bundler exposes during evaluation, and `performReactRefresh` is
 * what Vite calls after the module has re-run.
 */

// First, before `react-dom/client` evaluates: see the fixture's header.
import { RefreshRuntime } from "./__fixtures__/react-refresh";

import { Layer, Schema } from "effect";
import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { Action, createRuntime, define } from "./lib";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { component } = createRuntime(Layer.empty);

const Tally = define({
  props: Schema.Struct({ step: Schema.Number }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Action("Bumped", {})]),
});

const reducer = {
  Bumped: (
    _action: {},
    { state, props }: { state: { count: number }; props: { step: number } },
  ) => ({
    count: state.count + props.step,
  }),
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class ErrorBoundary extends Component<
  { readonly children?: ReactNode; readonly onError: (error: unknown) => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let errors: Array<unknown> = [];

const mount = async (element: ReactNode) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <ErrorBoundary onError={(error) => void errors.push(error)}>{element}</ErrorBoundary>,
    ),
  );
};

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  errors = [];
});

const text = (testId: string) =>
  container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

const click = async (testId: string) => {
  const element = container?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  await act(async () => element?.click());
};

/** What Vite does once the saved module has re-run: one refresh pass over every root. */
const refresh = async () => {
  await act(async () => {
    RefreshRuntime.performReactRefresh();
  });
};

/**
 * Evaluates a module the way a Babel-based bundler does: `$RefreshReg$` is on
 * the global for the duration, registering under the file's id.
 */
const evaluateWithRefreshReg = <T,>(file: string, evaluate: () => T): T => {
  const global = globalThis as { $RefreshReg$?: (type: unknown, id: string) => void };
  global.$RefreshReg$ = (type, id) => RefreshRuntime.register(type, `${file} ${id}`);
  try {
    return evaluate();
  } finally {
    delete global.$RefreshReg$;
  }
};

// ---------------------------------------------------------------------------
// Shape 1: the feature file is saved; a fragment lives in another file.
//
//   tally.tsx   export const TallyView = component(tally, { name: "Tally" })
//   count.tsx   import { TallyView } from "./tally"; TallyView.useFeature()
//
// `tally.tsx` exports only a component, so Vite lets it accept its own update
// and never re-runs `count.tsx`. The refresh re-renders the mounted fiber
// with the second `component()` result, keeping its store. `count.tsx` still
// holds the first `TallyView`; its `useFeature` reads the context for
// "Tally", which is the one the second mount provides.
// ---------------------------------------------------------------------------

// `count.tsx`, evaluated once. The binding stands for its live import.
let importedTallyView: ReturnType<typeof evaluateTallyModule> | undefined;

const Count = () => {
  const { state, dispatch } = importedTallyView!.useFeature();
  return (
    <button data-testid="count" onClick={() => dispatch({ _tag: "Bumped" })}>
      {state.count}
    </button>
  );
};
RefreshRuntime.register(Count, "count.tsx Count");

// `tally.tsx`; called once per evaluation.
function evaluateTallyModule(version: string) {
  const tally = Tally.create({
    initialState: () => ({ count: 0 }),
    reducer,
    render: () => (
      <div>
        <span data-testid="version">{version}</span>
        <Count />
      </div>
    ),
  });
  const TallyView = component(tally, { name: "Tally" });
  RefreshRuntime.register(TallyView, "tally.tsx TallyView");
  return TallyView;
}

test("saving the feature file: a fragment in another file keeps working, the edit lands, state survives", async () => {
  const TallyView = evaluateTallyModule("v1");
  importedTallyView = TallyView;

  await mount(<TallyView step={1} />);
  await vi.waitFor(() => expect(text("count")).toBe("0"));
  await click("count");
  expect(text("count")).toBe("1");

  // The save. `count.tsx` is not touched, so `importedTallyView` stays v1.
  evaluateTallyModule("v2");
  await refresh();

  await vi.waitFor(() => expect(text("version")).toBe("v2"));
  expect(text("count")).toBe("1");
  expect(errors).toHaveLength(0);

  // The fragment still dispatches into the surviving store.
  await click("count");
  expect(text("count")).toBe("2");
});

// ---------------------------------------------------------------------------
// Shape 2: the feature file is saved and holds its own fragment, but the
// Babel plugin did not register the component.
//
//   search.tsx  const Hits = () => SearchView.useFeature() …
//               export const SearchView = component(search, { name: "Search" })
//
// The plugin registers `const X = component(x, …)` only when the same file
// also renders `<X />`; `Hits`, an arrow function, always qualifies. The
// refresh swaps `Hits` for the new one while the mounted fiber is still the
// old `SearchView`. Both read the context for "Search", so the fragment
// keeps working. Whether the `render` edit lands depends on the bundler: one
// that exposes `$RefreshReg$` during evaluation lets `component()` register
// the mount itself. (A real plugin-react server also registers exported
// components once the file is a refresh boundary; the harness leaves that
// out to isolate the two paths.)
// ---------------------------------------------------------------------------

function evaluateSearchModule(version: string) {
  const search = Tally.create({
    initialState: () => ({ count: 0 }),
    reducer,
    render: () => (
      <div>
        <span data-testid="version">{version}</span>
        <Hits />
      </div>
    ),
  });
  const SearchView = component(search, { name: "Search" });
  const Hits = () => {
    const { state, dispatch } = SearchView.useFeature();
    return (
      <button data-testid="count" onClick={() => dispatch({ _tag: "Bumped" })}>
        {state.count}
      </button>
    );
  };
  RefreshRuntime.register(Hits, "search.tsx Hits");
  return SearchView;
}

test("saving the feature file without `$RefreshReg$`: the same-file fragment keeps working; the render edit waits", async () => {
  const SearchView = evaluateSearchModule("v1");

  await mount(<SearchView step={1} />);
  await vi.waitFor(() => expect(text("count")).toBe("0"));
  await click("count");
  expect(text("count")).toBe("1");

  evaluateSearchModule("v2");
  await refresh();

  // Nothing registered the mount, so the old one keeps rendering; the swapped
  // fragment reads the same named context and sees the store.
  expect(errors).toHaveLength(0);
  expect(text("version")).toBe("v1");
  expect(text("count")).toBe("1");
  await click("count");
  expect(text("count")).toBe("2");
});

test("saving the feature file with `$RefreshReg$`: `component()` registers the mount and the render edit lands", async () => {
  const SearchView = evaluateWithRefreshReg("search-reg.tsx", () => evaluateSearchModule("v1"));

  await mount(<SearchView step={1} />);
  await vi.waitFor(() => expect(text("count")).toBe("0"));
  await click("count");
  expect(text("count")).toBe("1");

  evaluateWithRefreshReg("search-reg.tsx", () => evaluateSearchModule("v2"));
  await refresh();

  await vi.waitFor(() => expect(text("version")).toBe("v2"));
  expect(text("count")).toBe("1");
  expect(errors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Names are the scope.
// ---------------------------------------------------------------------------

const plain = Tally.create({
  initialState: () => ({ count: 0 }),
  reducer,
  render: ({ state }) => <span data-testid="count">{state.count}</span>,
});

test("two names stay independent: `A.useFeature()` under `<B>` throws, naming `A`", async () => {
  const A = component(plain, { name: "Alpha" });
  const AFragment = () => <span data-testid="a">{A.useFeature().state.count}</span>;

  const beta = Tally.create({
    initialState: () => ({ count: 0 }),
    reducer,
    render: () => <AFragment />,
  });
  const B = component(beta, { name: "Beta" });

  await mount(<B step={1} />);

  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(String(errors[0])).toMatch(/Alpha\.useFeature\(\) called outside <Alpha>/);
});

test("one name shares the scope: a fragment made against one call resolves a mount of the other", async () => {
  const First = component(plain, { name: "Shared" });
  const FirstFragment = () => <span data-testid="shared">{First.useFeature().state.count}</span>;

  const second = Tally.create({
    initialState: () => ({ count: 7 }),
    reducer,
    render: () => <FirstFragment />,
  });
  const Second = component(second, { name: "Shared" });

  await mount(<Second step={1} />);

  await vi.waitFor(() => expect(text("shared")).toBe("7"));
  expect(errors).toHaveLength(0);
});

test("`component()` without a name throws, for callers outside the type system", () => {
  expect(() => (component as (f: unknown) => unknown)(plain)).toThrow("component() needs a name");
  expect(() => (component as (f: unknown, o: unknown) => unknown)(plain, {})).toThrow(
    "component() needs a name",
  );
});

// ---------------------------------------------------------------------------
// Control: component and fragment in one file, both registered.
//
// Both sides come from the same evaluation, so the refresh has nothing to
// bridge. The edit lands, the store and its state survive, nothing throws.
// It also proves the harness performs a real refresh.
// ---------------------------------------------------------------------------

function evaluateRegisteredModule(version: string) {
  const feature = Tally.create({
    initialState: () => ({ count: 0 }),
    reducer,
    render: () => (
      <div>
        <span data-testid="version">{version}</span>
        <Shown />
      </div>
    ),
  });
  const View = component(feature, { name: "Registered" });
  const Shown = () => {
    const { state, dispatch } = View.useFeature();
    return (
      <button data-testid="count" onClick={() => dispatch({ _tag: "Bumped" })}>
        {state.count}
      </button>
    );
  };
  RefreshRuntime.register(Shown, "registered.tsx Shown");
  RefreshRuntime.register(View, "registered.tsx View");
  return View;
}

test("control: a registered component and its fragment in one file refresh together, keeping state", async () => {
  const View = evaluateRegisteredModule("v1");

  await mount(<View step={1} />);
  await vi.waitFor(() => expect(text("count")).toBe("0"));
  await click("count");
  expect(text("count")).toBe("1");

  evaluateRegisteredModule("v2");
  await refresh();

  await vi.waitFor(() => expect(text("version")).toBe("v2"));
  expect(text("count")).toBe("1");
  expect(errors).toHaveLength(0);
});
