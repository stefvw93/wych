---
title: Recover from a failed layer
description: Handle a feature layer that fails to build, count attempts, and give up after a limit.
order: 8
---

# Recover from a failed layer

A feature `layer` can fail to build: a socket refuses to connect, a token has
expired. The failure reaches the `Error` handler with `from: "Mounted"`, the
same channel a dying command uses. Render a Retry button from that handler,
and Wych rebuilds the layer the next time the button is clicked.

```tsx
import { Context, Effect, Layer, Schema } from "effect";
import { Action, Command, createRuntime, define } from "@wych/react";

class Metrics extends Context.Service<Metrics, { readonly snapshot: Effect.Effect<number> }>()(
  "Metrics",
) {}

const Loaded = Action("Loaded", { value: Schema.Number });
const Retry = Action("Retry", {});

const loadMetrics = Command.effect<{ readonly _tag: "Loaded"; readonly value: number }, Metrics>(
  (dispatch) =>
    Effect.gen(function* () {
      const metrics = yield* Metrics;
      const value = yield* metrics.snapshot;
      yield* dispatch({ _tag: "Loaded", value });
    }),
);

const Dashboard = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ status: Schema.String, attempts: Schema.Number, value: Schema.Number }),
  action: Action.of([Loaded, Retry]),
});

export const dashboard = Dashboard.create({
  initialState: Dashboard.initialState(() => ({ status: "connecting", attempts: 0, value: 0 })),
  reducer: Dashboard.reducer({
    Mounted: (_payload, { state }) => [state, loadMetrics],
    Retry: (_payload, { state }) => [{ ...state, status: "connecting" }, loadMetrics],
    Loaded: ({ value }, { state }) => ({ ...state, status: "loaded", value }),
    Error: ({ from }, { state }) => {
      const attempts = state.attempts + 1;
      return from === "Mounted" && attempts < 3
        ? { ...state, status: "failed", attempts }
        : { ...state, status: "gaveUp", attempts };
    },
  }),
  render: Dashboard.render(({ state, dispatch }) => (
    <div>
      <span data-testid="status">{state.status}</span>
      {state.status === "failed" ? (
        <button onClick={() => dispatch({ _tag: "Retry" })}>Retry</button>
      ) : null}
      {state.status === "gaveUp" ? <p>Could not connect. Reload the page.</p> : null}
      {state.status === "loaded" ? <p>{state.value}</p> : null}
    </div>
  )),
});
```

`Mounted` fires only once the layer built, so it never sees `from: "Mounted"`
failures itself; those short-circuit straight to `Error` before `Mounted`
folds. `Retry` and `Mounted` share `loadMetrics`, so the first load and every
retried load run the same command.

The `Error` handler above returns bare state for `from: "Mounted"`, never a
command. A layer that failed to build leaves no mount fiber to run a command
in, so a command returned here is dropped (devtools reports it as a `Command`
event with `dropped: true`). Only a command a dispatch produces rebuilds the
layer, which is why the button dispatches `Retry` instead of the handler
returning `loadMetrics` directly.

## Count attempts and give up

The `Error` handler is a pure fold over `from` and the running count, so it
takes no mount to prove.

```ts continue
import { Cause } from "effect";
import { Next } from "@wych/react";

const firstFailure = dashboard.reduce(
  {
    _tag: "Error",
    error: new Error("refused"),
    cause: Cause.die(new Error("refused")),
    from: "Mounted",
  },
  { state: { status: "connecting", attempts: 0, value: 0 }, props: {}, hooks: {} },
);

console.log(Next.state(firstFailure));
// => { status: "failed", attempts: 1, value: 0 }

const thirdFailure = dashboard.reduce(
  {
    _tag: "Error",
    error: new Error("refused"),
    cause: Cause.die(new Error("refused")),
    from: "Mounted",
  },
  { state: { status: "failed", attempts: 2, value: 0 }, props: {}, hooks: {} },
);

console.log(Next.state(thirdFailure));
// => { status: "gaveUp", attempts: 3, value: 0 }
```

Branching on `from` matters here: a defect from `Loaded`'s own command (a bug
in `metrics.snapshot`, say) would carry `from: "Loaded"` and fall straight to
`"gaveUp"` on the first attempt, because that failure is not the layer and a
Retry click would not change its outcome.

## Retry rebuilds the layer

Only a dispatch that did not originate from a lifecycle action or a running
command rebuilds a dead mount. A click handler's `dispatch({ _tag: "Retry" })`
qualifies, so the button in the snippet above is the trigger, not `loadMetrics`
calling `dispatch` from inside itself, and not `Mounted`'s own command on the
rebuilt mount. That is what stops a permanently failing layer from spinning:
each Retry click rebuilds the layer exactly once, and a build that fails again
reaches `Error` with `from: "Mounted"` a second time rather than looping on
its own.

Unmounting a dead mount still folds `Unmounted`, so a cleanup command written
there still runs. See [`Error`](/docs/reference/lifecycle#error) for the full
set of origins `from` reports, and
[assert on a dying command](/docs/how-to/test-a-feature-without-react#assert-on-a-dying-command)
for testing the reducer half of a defect without a mount.
