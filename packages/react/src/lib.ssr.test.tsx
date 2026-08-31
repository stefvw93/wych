/**
 * Server-side rendering, in node.
 *
 * `renderToString` runs the whole render path — `validateProps`, the store's
 * `useState` construction, `sync`'s baseline seeding, `useSyncExternalStore`,
 * the snapshot provider — but no effects. So the initial state must paint, and
 * nothing may fold: `start` lives in `useEffect`, which the server never runs.
 * The one server-only requirement is `useSyncExternalStore`'s third argument;
 * without it React throws `Missing getServerSnapshot`.
 */

import { Effect, Layer, Schema } from "effect";
import { renderToString } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { Action, Command, createRuntime, define } from "./lib";

const { component, Provider } = createRuntime(Layer.empty);

let lifecycleFolds = 0;
let commandsRun = 0;

const Announced = Action.output("Announced", { at: Schema.Number });

const counter = define({
  props: Schema.Struct({ start: Schema.Number }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Action("Bumped", {})]),
  output: Action.of([Announced]),
}).create({
  initialState: (props) => ({ count: props.start }),
  reducer: {
    Bumped: (_action, { state }) => ({ count: state.count + 1 }),
    Mounted: (_action, { state }) => {
      lifecycleFolds += 1;
      return [
        state,
        Command.effect(() =>
          Effect.sync(() => {
            commandsRun += 1;
          }),
        ),
      ];
    },
    PropsChanged: (_action, { state }) => {
      lifecycleFolds += 1;
      return state;
    },
  },
  render: ({ state, dispatch }) => (
    <div>
      <span data-testid="count">{state.count}</span>
      <button onClick={() => dispatch({ _tag: "Bumped" })}>bump</button>
      <Fragment />
    </div>
  ),
});

const CounterView = component(counter, { name: "SsrCounter" });

/** A `useFeature` fragment, so the provider is exercised server-side too. */
const Fragment = () => {
  const { state, props } = CounterView.useFeature();
  return <span data-testid="fragment">{`${props.start}:${state.count}`}</span>;
};

test("renderToString paints the initial state and folds nothing", () => {
  const html = renderToString(<CounterView start={5} onAnnounced={() => {}} />);

  expect(html).toContain(">5</span>");
  // The fragment resolved its provider on the server.
  expect(html).toContain("5:5");

  // No effects on the server: no `Mounted`, no `PropsChanged`, no command.
  expect(lifecycleFolds).toBe(0);
  expect(commandsRun).toBe(0);
});

test("renderToString under the runtime Provider behaves identically", () => {
  const html = renderToString(
    <Provider>
      <CounterView start={7} onAnnounced={() => {}} />
    </Provider>,
  );
  expect(html).toContain(">7</span>");
  expect(html).toContain("7:7");
});

test("a malformed prop still throws on the server, where the render is", () => {
  expect(() =>
    renderToString(
      <CounterView
        {...({ start: "not a number" } as unknown as React.ComponentProps<typeof CounterView>)}
      />,
    ),
  ).toThrow(/Invalid props for <SsrCounter>/);
});
