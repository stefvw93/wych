/**
 * Type-level exercises for `subscriptions.specs.md` ("Type-level (TSTyche)").
 *
 * Red until `Subscription`, `Subscriptions`, the `subscriptions` hook on
 * `create`, and `run`'s new result field exist. Run from the repo root:
 *
 *     vp -C packages/react run test:types
 *
 * A `@ts-expect-error` that stops being needed is itself an error, so a
 * rejection below is only green once the guard it names is real.
 */

import { Effect, Layer, Schema } from "effect";
import { expect, test } from "tstyche";
import type { ReactNode } from "react";
import {
  Action,
  Children,
  Command,
  createRuntime,
  define,
  type Snapshot,
  Subscription,
  type Subscriptions,
} from "../lib";

interface PresenceApi {
  readonly _presence: unique symbol;
}
declare const presenceEffect: Effect.Effect<void, never, PresenceApi>;
declare const presenceLayer: Layer.Layer<PresenceApi>;

const Contextual = define({
  props: Schema.Struct({ room: Schema.String }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Action("Ping", {}), Action("Pong", { at: Schema.Number })]),
  output: Action.of([Action.output("Left", { id: Schema.String })]),
});

// HINT: `Subscription<A, R>` is covariant in `A` on the same terms as
// `Command` — `A` only appears under `Dispatcher<A>` in a parameter, twice
// contravariant, so narrow-to-wide holds. `never` is the bottom.
test("`Subscription<Narrow>` fits a `Subscription<Wide>` slot, and the empty leaf fits everywhere", () => {
  expect<Subscription<{ readonly _tag: "X" }>>().type.toBeAssignableTo<
    Subscription<{ readonly _tag: "X" } | { readonly _tag: "Y" }>
  >();

  expect(Subscription.effect(() => Effect.void)).type.toBe<Subscription<never, never>>();
  expect(Subscription.effect(() => Effect.void)).type.toBeAssignableTo<
    Subscription<{ readonly _tag: "X" }, PresenceApi>
  >();

  // The error channel is closed, as for a command.
  expect(Subscription.effect).type.not.toBeCallableWith(() => Effect.fail("boom"));
});

// HINT: `create`'s `subscriptions` parameter is typed
// `(snapshot: Snapshot<Props, State, H>) => Subscriptions<Emit<A, O>, R>`; the
// contextual type flows into the record values and from there into the leaf's
// `dispatch`. Direct calls, not `toBeCallableWith` — see the note above the
// same test for `Command.effect` in `core.tst.ts`.
test("inside the hook, `dispatch` is typed by the feature's vocabulary", () => {
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
    subscriptions: ({ props }) => ({
      [`presence:${props.room}`]: Subscription.effect((dispatch) =>
        Effect.andThen(dispatch({ _tag: "Pong", at: 1 }), dispatch({ _tag: "Left", id: "u1" })),
      ),
    }),
  });

  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
    subscriptions: () => ({
      // @ts-expect-error is not assignable to type '"Ping" | "Pong" | "Left"'
      nope: Subscription.effect((dispatch) => dispatch({ _tag: "Nope" })),
    }),
  });

  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
    subscriptions: () => ({
      // @ts-expect-error is not assignable to parameter of type
      wrong: Subscription.effect((dispatch) => dispatch({ _tag: "Pong" })),
    }),
  });
});

// HINT: same rule as `Command.effect`: `A` has no inference site of its own.
test("standalone, `Subscription.effect` infers `A = never` and needs the type argument", () => {
  // @ts-expect-error is not assignable to parameter of type 'never'
  Subscription.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 }));

  expect(
    Subscription.effect<{ readonly _tag: "Pong"; readonly at: number }>((dispatch) =>
      dispatch({ _tag: "Pong", at: 1 }),
    ),
  ).type.toBe<Subscription<{ readonly _tag: "Pong"; readonly at: number }, never>>();
});

// HINT: `SubscriptionServicesOf<S>` reads `R` off the hook's return record
// values (a mapped type over the record, indexed by its keys, `never` when
// there is no hook), and `create`'s `R` becomes
// `ServicesOf<U> | SubscriptionServicesOf<S>`.
test("`Subscription.effect` carries `R`, and `create` unions it into the feature's `R`", () => {
  expect(Subscription.effect(() => presenceEffect)).type.toBe<Subscription<never, PresenceApi>>();

  const needsPresence = Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
    subscriptions: () => ({ presence: Subscription.effect(() => presenceEffect) }),
  });

  // `{ name }` is required on every `component` call; without it the negative
  // assertion would pass for the wrong reason.
  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(needsPresence, {
    name: "Presence",
  });
  expect(createRuntime(presenceLayer).component).type.toBeCallableWith(needsPresence, {
    name: "Presence",
  });
  expect(createRuntime(Layer.empty).component).type.toBeCallableWith(needsPresence, {
    layer: presenceLayer,
    name: "Presence",
  });
});

// HINT: the leaf above is not context-sensitive, so it is typed in one pass.
// The real shape — `(dispatch) => Effect.gen(…)` reading a service — defers
// the leaf to the second pass, where `A` is already fixed from the slot and
// `R` is still read off the effect. Both `Definition.subscriptions` and
// `create` must land `R` with no type argument, or the DX is worse than a
// bare `Effect.gen`.
test("`R` is inferred through a context-sensitive leaf, with no type argument", () => {
  const hook = Contextual.subscriptions(({ props }) => ({
    [`presence:${props.room}`]: Subscription.effect((dispatch) =>
      Effect.andThen(presenceEffect, dispatch({ _tag: "Pong", at: 1 })),
    ),
  }));
  expect(hook).type.toBe<
    (
      snapshot: Snapshot<{ readonly room: string }, { readonly count: number }, {}>,
    ) => Subscriptions<
      | { readonly _tag: "Ping" }
      | { readonly _tag: "Pong"; readonly at: number }
      | { readonly _tag: "Left"; readonly id: string },
      PresenceApi
    >
  >();

  const feature = Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
    subscriptions: ({ props }) => ({
      [`presence:${props.room}`]: Subscription.effect((dispatch) =>
        Effect.andThen(presenceEffect, dispatch({ _tag: "Pong", at: 1 })),
      ),
    }),
  });
  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(feature, {
    name: "Presence",
  });
  expect(createRuntime(presenceLayer).component).type.toBeCallableWith(feature, {
    name: "Presence",
  });
});

// HINT: structurally, `Subscription`'s one variant *is* `Command`'s `Effect`
// variant, so a `Subscription` would slide into a `Next` tuple unnoticed. Give
// `Subscription` a nominal marker — a `unique symbol`-keyed phantom field on
// the type, set by the constructor — so neither direction is assignable.
// `Next` admits `Command` only; the hook's record admits `Subscription` only.
test("a `Command` in the hook and a `Subscription` from a handler are both compile errors", () => {
  // Reported on the hook, not on `cmd`: `subscriptions` is optional, so its
  // target type is a union with `undefined`, and TypeScript does not
  // elaborate an arrow body against a union target. The message still names
  // the hook's type, which is what the directive matches.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
    // @ts-expect-error is not assignable to type 'Subscription
    subscriptions: () => ({
      cmd: Command.effect(() => Effect.void),
    }),
  });

  // The tuple's second element is checked against `Command | LazyCommand`,
  // so the message names `Command`, not `Next`; the incompatible property is
  // the nominal marker.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      // @ts-expect-error is not assignable to type 'Command
      Ping: (_a, s) => [s.state, Subscription.effect(() => Effect.void)] as const,
      Pong: (_a, s) => s.state,
    },
    render: () => null,
  });
});

// HINT: the identity typer on `FeatureDefinition` supplies the parameter type,
// so a hook written in its own file sees `children` and `hooks` as declared.
test("the hook's parameter is `Snapshot<Props, State, H>`", () => {
  const WithHooks = define({
    props: Schema.Struct({ room: Schema.String, children: Children }),
    state: Schema.Struct({ count: Schema.Number }),
    action: Action.of([Action("Ping", {})]),
    useUnsafeHooks: () => ({ online: true as boolean }),
  });

  WithHooks.subscriptions((snapshot) => {
    expect(snapshot).type.toBe<
      Snapshot<
        { readonly room: string; readonly children: ReactNode },
        { readonly count: number },
        { online: boolean }
      >
    >();
    return {};
  });
});

// HINT: `Feature.run`'s result gains `subscriptions: ReadonlyArray<string>`;
// `Feature.subscriptions` is `(snapshot) => Subscriptions<Action | Output, R>`.
test("`run`'s result and `Feature.subscriptions` are typed", () => {
  const feature = Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
  });

  type Result = Effect.Success<ReturnType<typeof feature.run>>;
  expect<Result["subscriptions"]>().type.toBe<ReadonlyArray<string>>();

  expect(feature.subscriptions).type.toBe<
    (
      snapshot: Snapshot<{ readonly room: string }, { readonly count: number }, {}>,
    ) => Subscriptions<
      | { readonly _tag: "Ping" }
      | { readonly _tag: "Pong"; readonly at: number }
      | { readonly _tag: "Left"; readonly id: string },
      never
    >
  >();
});

// HINT: today an unknown handler key compiles (probed: `reducer: { Ping, subscriptions: () => ({}) }`
// passes tstyche), because `U` is inferred from the literal and excess-property
// checking never sees it. `Exhaustive<U, State>` is the place to add a per-key
// guard: a key that is neither an action tag nor a `LifecycleTag` maps to an
// error string, the same trick `state has no property …` already plays.
test("`subscriptions` is not a reducer key", () => {
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: (_a, s) => s.state,
      Pong: (_a, s) => s.state,
      // @ts-expect-error not a handler
      subscriptions: () => ({}),
    },
    render: () => null,
  });
});

// Beyond the exercises: the shapes a hook is actually written in, and what
// `.pipe` keeps.
test("a hook written as a ternary against `{}`, or with an `undefined` value, type-checks", () => {
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
    subscriptions: ({ state }) =>
      state.count > 0
        ? { feed: Subscription.effect((dispatch) => dispatch({ _tag: "Ping" })) }
        : {},
  });

  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
    subscriptions: ({ state }) => ({
      feed:
        state.count > 0 ? Subscription.effect((dispatch) => dispatch({ _tag: "Ping" })) : undefined,
    }),
  });

  // `R` still reaches the feature through either shape.
  const viaTernary = Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: { Ping: (_a, s) => s.state, Pong: (_a, s) => s.state },
    render: () => null,
    subscriptions: ({ state }) =>
      state.count > 0 ? { presence: Subscription.effect(() => presenceEffect) } : {},
  });
  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(viaTernary, {
    name: "Presence",
  });
});

test("`.pipe` on a subscription preserves `A` and `R`", () => {
  const sub = Subscription.effect<{ readonly _tag: "Pong"; readonly at: number }, PresenceApi>(
    () => presenceEffect,
  );
  expect(sub.pipe((self) => self)).type.toBe<
    Subscription<{ readonly _tag: "Pong"; readonly at: number }, PresenceApi>
  >();
});
