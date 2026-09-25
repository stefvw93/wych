import { Effect, Layer, Option, Schema, Stream } from "effect";
import { expect, test } from "tstyche";
import type { ComponentProps, FC, ReactNode } from "react";
import { drafterLayer, mutativeDrafter, type Draft } from "../draft";
import { Task, type TaskValue } from "../utils/task";
import {
  Action,
  type AnyMessage,
  Children,
  Command,
  createRuntime,
  define,
  type Dispatcher,
  type Disjoint,
  type Exhaustive,
  type FeatureComponent,
  type MemberOf,
  type MembersOf,
  type Message,
  Next,
  type LazyCommand,
  type NoPropCollision,
  type RunDefect,
  type OutputProps,
  type RenderSnapshot,
  type ServicesOf,
  Subscription,
  type TagsOf,
} from "../lib";

// ---------------------------------------------------------------------------
// Channel brand
// ---------------------------------------------------------------------------

test("the channel brand keeps internal and outbound messages mutually unassignable", () => {
  const ActionFoo = Action("Foo", { id: Schema.String });
  const OutputFoo = Action.output("Foo", { id: Schema.String });

  // Positive control: same tag, same fields, same channel stays assignable, so
  // the two rejections below are attributable to the brand rather than to some
  // unrelated structural difference between the two constructors.
  const ActionFooAgain = Action("Foo", { id: Schema.String });
  expect(ActionFoo).type.toBeAssignableTo<typeof ActionFooAgain>();

  expect(ActionFoo).type.not.toBeAssignableTo<typeof OutputFoo>();
  expect(OutputFoo).type.not.toBeAssignableTo<typeof ActionFoo>();

  // Stated on `Message` directly, since that is what the criterion is about:
  // the phantom, not the constructor that happened to apply it.
  type Fields = { readonly id: typeof Schema.String };
  expect<Message<"Foo", Fields, "internal">>().type.not.toBeAssignableTo<
    Message<"Foo", Fields, "outbound">
  >();
  expect<Message<"Foo", Fields, "outbound">>().type.not.toBeAssignableTo<
    Message<"Foo", Fields, "internal">
  >();
});

test("a reserved lifecycle tag cannot be declared as an action or output", () => {
  // Reserved tag: `NotLifecycleTag` narrows the guard to `never`, so the
  // literal argument can no longer satisfy the parameter.
  // @ts-expect-error is not assignable to parameter of type 'never'
  Action("Mounted", {});
  // @ts-expect-error is not assignable to parameter of type 'never'
  Action.output("Unmounted", {});

  // Every reserved tag, on both constructors. Two spot checks left three tags
  // unpinned — `HookChanged` most of all, being the newest member of
  // `LifecycleTag` and so the likeliest to be dropped by a refactor.
  expect(Action).type.not.toBeCallableWith("Mounted", {});
  expect(Action).type.not.toBeCallableWith("PropsChanged", {});
  expect(Action).type.not.toBeCallableWith("HookChanged", {});
  expect(Action).type.not.toBeCallableWith("Error", {});
  expect(Action).type.not.toBeCallableWith("Unmounted", {});

  expect(Action.output).type.not.toBeCallableWith("Mounted", {});
  expect(Action.output).type.not.toBeCallableWith("PropsChanged", {});
  expect(Action.output).type.not.toBeCallableWith("HookChanged", {});
  expect(Action.output).type.not.toBeCallableWith("Error", {});
  expect(Action.output).type.not.toBeCallableWith("Unmounted", {});

  // Control: an unreserved capitalised tag is still accepted, so the ten
  // rejections above are `NotLifecycleTag` and not a broken signature.
  expect(Action).type.toBeCallableWith("Mount", {});
  expect(Action.output).type.toBeCallableWith("Unmount", {});
});

test("`fields` is optional, and `make()` takes no argument only when nothing is required", () => {
  const Reverted = Action("Reverted");
  expect(Reverted.make()).type.toBe<{ readonly _tag: "Reverted" }>();
  expect(Reverted.make({})).type.toBe<{ readonly _tag: "Reverted" }>();

  const Typed = Action("Typed", { query: Schema.String });
  // @ts-expect-error Expected 1-2 arguments
  Typed.make();
  expect(Typed.make({ query: "a" })).type.toBe<{
    readonly _tag: "Typed";
    readonly query: string;
  }>();

  const Saved = Action.output("Saved");
  expect(Saved.make()).type.toBe<{ readonly _tag: "Saved" }>();
});

test("the record form declares one message per key, tag from the key", () => {
  const actions = Action({ Typed: { query: Schema.String }, Cleared: {} });
  expect(actions.Typed.make({ query: "a" })).type.toBe<{
    readonly _tag: "Typed";
    readonly query: string;
  }>();
  expect(actions.Cleared.make()).type.toBe<{ readonly _tag: "Cleared" }>();
  expect(actions.Typed).type.toBeAssignableTo<AnyMessage<"internal">>();
  expect(actions.Typed).type.not.toBeAssignableTo<AnyMessage<"outbound">>();

  const outputs = Action.output({ Saved: { id: Schema.String } });
  expect(outputs.Saved).type.toBeAssignableTo<AnyMessage<"outbound">>();
  expect(outputs.Saved).type.not.toBeAssignableTo<AnyMessage<"internal">>();
});

test("the record form rejects a lower-case key and a lifecycle key", () => {
  // @ts-expect-error must be capitalized
  Action({ typed: {} });
  // @ts-expect-error is a reserved lifecycle tag
  Action({ Mounted: {} });
  // @ts-expect-error is a reserved lifecycle tag
  Action.output({ Fine: {}, Unmounted: {} });
});

// ---------------------------------------------------------------------------
// Command.output — channel enforced at the point of use
// ---------------------------------------------------------------------------

test("`Command.output` rejects an internal message, accepts an outbound one", () => {
  const InternalFoo = Action("Foo", {});
  const OutboundFoo = Action.output("Foo", {});

  expect(Command.output).type.not.toBeCallableWith(InternalFoo, {});
  expect(Command.output).type.toBeCallableWith(OutboundFoo, {});

  // The payload is the message's fields minus `_tag`, so the discriminant
  // comes from the message and never from the caller. Without these, the
  // channel is checked but the thing being announced is not.
  const OrderPlaced = Action.output("OrderPlaced", { orderId: Schema.String });

  expect(Command.output).type.toBeCallableWith(OrderPlaced, { orderId: "order_1" });
  expect(Command.output).type.not.toBeCallableWith(OrderPlaced, {});
  expect(Command.output).type.not.toBeCallableWith(OrderPlaced, { orderId: 1 });
  expect(Command.output).type.not.toBeCallableWith(OrderPlaced, {
    _tag: "OrderPlaced",
    orderId: "order_1",
  });
});

// ---------------------------------------------------------------------------
// Member sources: the `action` and `output` slots
// ---------------------------------------------------------------------------

test("`MemberOf` flattens messages, records, tasks and nested arrays", () => {
  const Started = Action("Started");
  const records = Action({ Failed: { reason: Schema.String } });
  const load = Task("Load", { success: Schema.Number });
  const Source = [Started, [records, load]] as const;

  expect<TagsOf<typeof Source>>().type.toBe<
    "Started" | "Failed" | "LoadResolved" | "LoadRejected"
  >();
  expect<MembersOf<typeof Source>>().type.toBe<
    | { readonly _tag: "Started" }
    | { readonly _tag: "Failed"; readonly reason: string }
    | ({ readonly _tag: "LoadResolved"; readonly value: number } & {
        readonly _tag: "LoadResolved";
      })
    | ({ readonly _tag: "LoadRejected"; readonly error: string } & {
        readonly _tag: "LoadRejected";
      })
  >();
  expect<TagsOf<typeof records>>().type.toBe<"Failed">();
  expect<TagsOf<typeof Started>>().type.toBe<"Started">();
});

test("each slot takes its own channel only", () => {
  const props = Schema.Struct({});
  const state = Schema.Struct({});
  const In = Action("In");
  const Out = Action.output("Out");
  const announced = Task.output("Announced", { success: Schema.String });
  const folded = Task("Folded", { success: Schema.String });

  // Positive controls: a single message, a record, a task, an inline array.
  expect(define).type.toBeCallableWith({ props, state, action: In });
  expect(define).type.toBeCallableWith({ props, state, action: Action({ A: {} }) });
  expect(define).type.toBeCallableWith({ props, state, action: folded });
  expect(define).type.toBeCallableWith({
    props,
    state,
    action: [In, folded],
    output: [Out, announced],
  });

  expect(define).type.not.toBeCallableWith({ props, state, action: Out });
  expect(define).type.not.toBeCallableWith({ props, state, action: [In, Out] });
  expect(define).type.not.toBeCallableWith({ props, state, action: announced });
  expect(define).type.not.toBeCallableWith({ props, state, action: In, output: In });
  expect(define).type.not.toBeCallableWith({ props, state, action: In, output: folded });
  expect(define).type.not.toBeCallableWith({ props, state, action: In, output: Action({ B: {} }) });
});

// ---------------------------------------------------------------------------
// Disjoint
// ---------------------------------------------------------------------------

test("`Disjoint` rejects an action/output tag collision", () => {
  const Actions = [Action("Foo", {})];
  const NonCollidingOutputs = [Action.output("Bar", {})];
  const CollidingOutputs = [Action.output("Foo", {})];

  expect<
    Disjoint<MembersOf<typeof Actions>, MembersOf<typeof NonCollidingOutputs>>
  >().type.toBe<unknown>();
  expect<
    Disjoint<MembersOf<typeof Actions>, MembersOf<typeof CollidingOutputs>>
  >().type.toBe<never>();

  // Computing to `never` is only half of it — the guard has to be *wired* to
  // `define`'s `output` property. Intersected onto the wrong one, or dropped,
  // the two assertions above stay green while a colliding pair compiles.
  const props = Schema.Struct({});
  const state = Schema.Struct({});

  expect(define).type.toBeCallableWith({ props, state, action: Actions });
  expect(define).type.toBeCallableWith({
    props,
    state,
    action: Actions,
    output: NonCollidingOutputs,
  });
  expect(define).type.not.toBeCallableWith({
    props,
    state,
    action: Actions,
    output: CollidingOutputs,
  });
});

// ---------------------------------------------------------------------------
// NoPropCollision
// ---------------------------------------------------------------------------

test("`NoPropCollision` rejects a declared prop colliding with a derived `on<Tag>` name", () => {
  const Outputs = [Action.output("Foo", {})];
  const NonCollidingProps = Schema.Struct({ somethingElse: Schema.String });
  const CollidingProps = Schema.Struct({ onFoo: Schema.String });

  expect<
    NoPropCollision<typeof NonCollidingProps, MembersOf<typeof Outputs>>
  >().type.toBe<unknown>();
  expect<NoPropCollision<typeof CollidingProps, MembersOf<typeof Outputs>>>().type.toBe<never>();

  // Wired to `define`, not merely computing. The guard sits on `output`
  // alongside `Disjoint`, so a mis-wiring shows up here and nowhere above.
  const state = Schema.Struct({});
  const Actions = [Action("Bar", {})];

  expect(define).type.toBeCallableWith({
    props: NonCollidingProps,
    state,
    action: Actions,
    output: Outputs,
  });
  expect(define).type.not.toBeCallableWith({
    props: CollidingProps,
    state,
    action: Actions,
    output: Outputs,
  });

  // And the collision is with the *derived* name specifically: `onFoo` is a
  // perfectly good prop until an output called `Foo` exists to derive it.
  expect(define).type.toBeCallableWith({ props: CollidingProps, state, action: Actions });
});

// ---------------------------------------------------------------------------
// Transforming props schemas
// ---------------------------------------------------------------------------

test("a transforming props schema is accepted, and props surface as its `Type`", () => {
  const PlainProps = Schema.Struct({ id: Schema.String });
  const TransformingProps = Schema.Struct({ id: Schema.NumberFromString });

  const state = Schema.Struct({});
  const Actions = [Action("Bar", {})];

  expect(define).type.toBeCallableWith({ props: PlainProps, state, action: Actions });
  expect(define).type.toBeCallableWith({ props: TransformingProps, state, action: Actions });

  // Props are validated, never decoded: `define` normalizes the schema to its
  // `Type` side, so a codec field surfaces downstream as the decoded shape —
  // the parent passes `number`, never the wire string.
  const Transformed = define({ props: TransformingProps, state, action: Actions });

  expect<Parameters<Parameters<typeof Transformed.initialState>[0]>[0]>().type.toBe<{
    readonly id: number;
  }>();

  // `PropsSchema` stays the inference site: were it to fall back to its
  // constraint, props would degrade to a record of `unknown` downstream.
  const Defined = define({ props: PlainProps, state, action: Actions });

  expect<Parameters<Parameters<typeof Defined.initialState>[0]>[0]>().type.toBe<{
    readonly id: string;
  }>();
});

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

test("`Children` is a props field that surfaces as `ReactNode`", () => {
  const ChildrenProps = Schema.Struct({ children: Children });
  const OptionalChildrenProps = Schema.Struct({ children: Schema.optionalKey(Children) });

  const state = Schema.Struct({});
  const Actions = [Action("Bar", {})];

  expect(define).type.toBeCallableWith({ props: ChildrenProps, state, action: Actions });

  const Defined = define({ props: ChildrenProps, state, action: Actions });

  // What a reducer, `initialState` and `render` see: the node itself, not a
  // wrapper anything has to unwrap before rendering it.
  expect<Parameters<Parameters<typeof Defined.initialState>[0]>[0]>().type.toBe<{
    readonly children: ReactNode;
  }>();

  const OptionalDefined = define({ props: OptionalChildrenProps, state, action: Actions });

  expect<Parameters<Parameters<typeof OptionalDefined.initialState>[0]>[0]>().type.toBe<{
    readonly children?: ReactNode;
  }>();

  // `Children.as<T>()` is the same declaration at another children type, and
  // the type argument is the whole contract — a render prop reaches `render`
  // as the function the parent passed.
  type Row = { readonly id: string };
  const RenderProp = Schema.Struct({ children: Children.as<(row: Row) => ReactNode>() });

  const RenderPropDefined = define({ props: RenderProp, state, action: Actions });

  expect<Parameters<Parameters<typeof RenderPropDefined.initialState>[0]>[0]>().type.toBe<{
    readonly children: (row: Row) => ReactNode;
  }>();
});

// ---------------------------------------------------------------------------
// Exhaustive / Excess
// ---------------------------------------------------------------------------

test("`Exhaustive` catches a reducer handler returning an unknown state key", () => {
  type TestState = { readonly count: number };

  type GoodHandlers = {
    readonly Inc: (action: any, snapshot: any) => TestState;
  };
  type BadHandlers = {
    readonly Inc: (action: any, snapshot: any) => { readonly count: number; readonly lmao: number };
  };

  expect<Exhaustive<GoodHandlers, TestState>>().type.toBe<{ readonly Inc: unknown }>();
  expect<Exhaustive<BadHandlers, TestState>>().type.toBe<{
    readonly Inc: "state has no property lmao";
  }>();

  // The synthetic types above cannot show the guard is attached where it has
  // to run. It exists precisely because TypeScript's own excess-property check
  // does *not* fire through an inferred return type — an unannotated handler
  // returning `{ count, lmao }` type-checks on its own — so the only thing
  // standing between that and a compiling feature is the intersection on
  // `create`'s `reducer` parameter.
  const Defined = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: [Action("Inc", {})],
  });

  expect(Defined.create).type.toBeCallableWith({
    initialState: () => ({ count: 0 }),
    reducer: { Inc: (_action: unknown, snapshot: { state: TestState }) => snapshot.state },
    render: () => null,
  });

  expect(Defined.create).type.not.toBeCallableWith({
    initialState: () => ({ count: 0 }),
    reducer: { Inc: () => ({ count: 1, lmao: 5 }) },
    render: () => null,
  });

  // `FeatureDefinition.reducer` carries the same guard, for reducers written in their
  // own file rather than inline.
  expect(Defined.reducer).type.not.toBeCallableWith({ Inc: () => ({ count: 1, lmao: 5 }) });
});

// ---------------------------------------------------------------------------
// ServicesOf — the regression this type exists to prevent
// ---------------------------------------------------------------------------

interface FooService {
  readonly _foo: unique symbol;
}
interface BarService {
  readonly _bar: unique symbol;
}

declare const fooEffect: Effect.Effect<void, never, FooService>;
declare const barEffect: Effect.Effect<void, never, BarService>;

test("`ServicesOf` unions services across handlers instead of collapsing to `never`", () => {
  type Handlers = {
    readonly A: (
      action: any,
      snapshot: any,
    ) => readonly [{ readonly count: number }, Command<never, FooService>];
    readonly B: (
      action: any,
      snapshot: any,
    ) => readonly [{ readonly count: number }, Command<never, BarService>];
    // A handler that returns bare state (no command) contributes no service —
    // it must not collapse the union to `never`.
    readonly C: (action: any, snapshot: any) => { readonly count: number };
  };

  expect<ServicesOf<Handlers>>().type.toBe<FooService | BarService>();

  // Through a real `create`, which is where the regression actually lives.
  // `R` cannot be inferred directly — candidates gathered from separate
  // properties of a mapped type do not accumulate into a union — so `create`
  // infers the reducer *record* and `ServicesOf` walks it afterwards. A
  // version that inferred `R` the naive way silently drops services, and the
  // synthetic assertion above keeps passing while it does.
  const Defined = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: [Action("A", {}), Action("B", {}), Action("C", {})],
  });

  const feature = Defined.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      A: () => [{ count: 1 }, Command.effect(() => fooEffect)] as const,
      B: () => [{ count: 1 }, Command.effect(() => barEffect)] as const,
      // Contributes no service, and must not collapse the union to `never`.
      C: () => ({ count: 1 }),
    },
    render: () => null,
  });

  // `run` is where `R` becomes observable: it demands a layer providing it.
  expect<Parameters<typeof feature.run>[1]["layer"]>().type.toBe<
    Layer.Layer<FooService | BarService>
  >();
});

// ---------------------------------------------------------------------------
// OutputProps
// ---------------------------------------------------------------------------

test("`OutputProps` derives one required `on<Tag>` prop per output, with `_tag` stripped", () => {
  const Outputs = [
    Action.output("OrderPlaced", { orderId: Schema.String }),
    Action.output("Cancelled", { reason: Schema.String }),
  ];
  type Props = OutputProps<MemberOf<typeof Outputs>>;

  // Two outputs, because "one per case" is exactly what a single-output
  // assertion cannot show: a mapped type that collapsed the union to its first
  // member would satisfy the old version of this test.
  expect<Props>().type.toBe<{
    readonly onOrderPlaced: (payload: { readonly orderId: string }) => void;
    readonly onCancelled: (payload: { readonly reason: string }) => void;
  }>();

  expect<Props["onOrderPlaced"]>().type.toBeCallableWith({ orderId: "order_1" });
  // `_tag` is not part of the payload type, so passing it is an excess property.
  expect<Props["onOrderPlaced"]>().type.not.toBeCallableWith({
    _tag: "OrderPlaced",
    orderId: "order_1",
  });

  // Required, not optional. This is the whole argument for per-output props
  // over one `onOutput` handler: a parent that does not care has to write
  // `onCancelled={() => {}}` and be visibly ignoring it, rather than
  // announcing into the void by default.
  expect<{
    readonly onOrderPlaced: (payload: { readonly orderId: string }) => void;
  }>().type.not.toBeAssignableTo<Props>();

  // And it degrades to `{}` for a feature that declares no outputs, so the
  // channel split stays free for a leaf feature.
  expect<OutputProps<never>>().type.toBe<{}>();
});

// ---------------------------------------------------------------------------
// The command leaf — `Command.effect`
// ---------------------------------------------------------------------------

interface PipeableFooService {
  readonly _foo: unique symbol;
}
declare const named: Command<{ readonly _tag: "X" }, PipeableFooService>;

const Contextual = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ count: Schema.Number }),
  action: [Action("Ping", {}), Action("Pong", { at: Schema.Number })],
});

test("`Command.effect` carries `R` out of its effect and emits nothing by default", () => {
  // The parameter is ignored by a command that emits nothing, which is why
  // there is no second "cannot emit" constructor: it is this one, unused.
  expect(Command.effect(() => fooEffect)).type.toBe<Command<never, FooService>>();
  expect(Command.effect(() => Effect.void)).type.toBe<Command<never, never>>();

  // `Command<never>` is the bottom, so a command that emits nothing still fits
  // a slot expecting the feature's actions — see the covariance test below.
  expect(Command.effect(() => fooEffect)).type.toBeAssignableTo<
    Command<{ readonly _tag: "X" }, FooService>
  >();

  // The leaf is a callback, not an effect. Passing the effect itself — the
  // shape the pre-redesign surface took — no longer compiles.
  expect(Command.effect).type.not.toBeCallableWith(fooEffect);

  // The effect's error channel is closed: a command that can fail has to say
  // what it does about it, inside the effect, before the runtime sees it.
  expect(Command.effect).type.not.toBeCallableWith(() => Effect.fail("boom"));
});

test("the leaf's `dispatch` is typed by the feature it is written in", () => {
  // `A` has no inference site of its own — it sits behind `Dispatcher<A>` in a
  // parameter position — so it comes from the contextual type of the handler's
  // return. That is the whole ergonomic bet of the callback leaf: without it
  // every emission would need an explicit type argument, and the spec's own
  // examples would not compile as written.
  //
  // Written as direct calls rather than `toBeCallableWith`: that matcher types
  // its arguments on their own, with no contextual type from the signature
  // under test, so every context-sensitive callback inside one collapses to
  // `never` and the assertion would be measuring the matcher. A call that
  // type-checks in this file *is* the positive assertion.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [{ count: 1 }, Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 }))] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // An undeclared tag is rejected, which is the payoff for the above: the
  // emission is checked against the vocabulary rather than against `unknown`.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          // @ts-expect-error is not assignable to type '"Ping" | "Pong"'
          Command.effect((dispatch) => dispatch({ _tag: "Nope" })),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // A declared tag with the wrong payload, too — the fields travel with the tag.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          // @ts-expect-error is not assignable to parameter of type
          Command.effect((dispatch) => dispatch({ _tag: "Pong" })),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // Standalone — no contextual type — the type argument is how `A` is fixed.
  expect(
    Command.effect<{ readonly _tag: "Pong"; readonly at: number }>((dispatch) =>
      dispatch({ _tag: "Pong", at: 1 }),
    ),
  ).type.toBe<Command<{ readonly _tag: "Pong"; readonly at: number }, never>>();
});

test("`render`'s dispatch carries the outbound vocabulary too", () => {
  // Written as direct calls, same reasoning as above: the contextual type is
  // the thing under test. A dispatched output is routed by tag at the store,
  // so the view can announce without a mirror action in between.
  const Sent = Action.output("Sent", { at: Schema.Number });
  const Defined = define({
    props: Schema.Struct({}),
    state: Schema.Struct({}),
    action: [Action("Ping", {})],
    output: [Sent],
  });

  Defined.create({
    initialState: () => ({}),
    reducer: { Ping: (_action, snapshot) => snapshot.state },
    render: ({ dispatch }) => {
      dispatch({ _tag: "Ping" });
      dispatch({ _tag: "Sent", at: 1 });
      // @ts-expect-error is not assignable to type '"Ping" | "Sent"'
      dispatch({ _tag: "Nope" });
      // @ts-expect-error is not assignable to parameter of type
      dispatch({ _tag: "Sent" });
      return null;
    },
  });
});

test("`dispatch(Message, payload)` is the same message, on every dispatch", () => {
  // The schema form: the message's own schema and its payload, payload
  // omitted when there is none. Checked against the same vocabulary as the
  // value form, so an undeclared schema and a wrong payload are both errors.
  const Ping = Action("Ping");
  const Pong = Action("Pong", { at: Schema.Number });
  const Sent = Action.output("Sent", { at: Schema.Number });
  const Stray = Action("Stray");
  const Defined = define({
    props: Schema.Struct({}),
    state: Schema.Struct({}),
    action: [Ping, Pong],
    output: [Sent],
  });

  Defined.create({
    initialState: () => ({}),
    reducer: {
      Ping: (_action, { state }) => [
        state,
        Command.effect((dispatch) =>
          Effect.gen(function* () {
            yield* dispatch(Pong, { at: 1 });
            yield* dispatch(Ping);
            yield* dispatch(Sent, { at: 2 });
            // @ts-expect-error No overload matches this call
            yield* dispatch(Stray);
            // @ts-expect-error is not assignable to parameter of type
            yield* dispatch(Pong);
            // @ts-expect-error is not assignable to type 'number'
            yield* dispatch(Pong, { at: "1" });
          }),
        ),
      ],
      Pong: (_action, { state }) => state,
    },
    render: ({ dispatch }) => {
      dispatch(Ping);
      dispatch(Pong, { at: 1 });
      dispatch(Sent, { at: 1 });
      // @ts-expect-error No overload matches this call
      dispatch(Stray);
      // @ts-expect-error is not assignable to parameter of type
      dispatch(Sent, {});
      return null;
    },
    subscriptions: () => ({
      tick: Subscription.effect((dispatch) => dispatch(Pong, { at: 1 })),
    }),
  });

  // Standalone, `A` is `never` and the schema form admits nothing either.
  // @ts-expect-error No overload matches this call
  Command.effect((dispatch) => dispatch(Ping));

  // `Command.output` takes the same payload rule.
  const Saved = Action.output("Saved");
  expect(Command.output(Saved)).type.toBe<Command<{ readonly _tag: "Saved" }>>();
  expect(Command.output).type.not.toBeCallableWith(Sent);
});

test("`dispatch` passed as a callback infers the value form", () => {
  const Pong = Action("Pong", { at: Schema.Number });
  const Defined = define({
    props: Schema.Struct({}),
    state: Schema.Struct({}),
    action: [Pong],
  });
  Defined.create({
    initialState: () => ({}),
    reducer: { Pong: (_action, { state }) => state },
    render: () => null,
    subscriptions: () => ({
      feed: Subscription.effect((dispatch) =>
        Stream.runForEach(Stream.make(Pong.make({ at: 1 })), dispatch),
      ),
    }),
  });
});

test("a reducer handler receives the payload — `_tag` stripped by the runtime", () => {
  // The handler key already names the tag, so the parameter is the remainder:
  // plain data, storable in state or forwardable into a command whole.
  const Defined = define({
    props: Schema.Struct({ id: Schema.String }),
    state: Schema.Struct({ count: Schema.Number }),
    action: [Action("Set", { count: Schema.Number })],
  });

  const reducer = Defined.reducer({
    Set: (payload, snapshot) => ({ ...snapshot.state, ...payload }),
    PropsChanged: (_payload, snapshot) => snapshot.state,
  });

  expect<Parameters<typeof reducer.Set>[0]>().type.toBe<{ readonly count: number }>();
  expect<Parameters<NonNullable<typeof reducer.PropsChanged>>[0]>().type.toBe<{
    readonly previous: { readonly id: string };
  }>();
});

test("`Dispatcher` is contravariant in `A`, which is what makes `Command` covariant", () => {
  // A dispatcher accepting the wider union stands in wherever the narrow one
  // is expected. `Command` puts this in a parameter position a second time,
  // and two contravariant hops compose to covariant — the property the test
  // below asserts on `Command` itself.
  expect<Dispatcher<{ readonly _tag: "X" } | { readonly _tag: "Y" }>>().type.toBeAssignableTo<
    Dispatcher<{ readonly _tag: "X" }>
  >();
  expect<Dispatcher<{ readonly _tag: "X" }>>().type.not.toBeAssignableTo<
    Dispatcher<{ readonly _tag: "X" } | { readonly _tag: "Y" }>
  >();

  // It returns an `Effect`, so it composes with the effect that calls it. A
  // `void` callback would force every call site into `Effect.sync`.
  expect<ReturnType<Dispatcher<{ readonly _tag: "X" }>>>().type.toBe<Effect.Effect<void>>();
});

// ---------------------------------------------------------------------------
// `keyed`, `restart`, `batch`, `cancel` — the supervisor's whole vocabulary
// ---------------------------------------------------------------------------

test("`Command.keyed` names a command and preserves `A` and `R`", () => {
  expect(named.pipe(Command.keyed("query"))).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // Not only through `.pipe`: it is a plain function of a command too.
  expect(Command.keyed("query")(named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // Chained, since nesting is answerable at runtime (outermost wins) and the
  // types have to survive it too.
  expect(named.pipe(Command.keyed("outer")).pipe(Command.keyed("inner"))).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // Two arguments, which is the form that keeps contextual inference alive —
  // see the test below for what it buys.
  expect(Command.keyed("query", named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // The key is required, and it is a string: the group address is data the
  // runtime compares, not an arbitrary token.
  expect(Command.keyed).type.not.toBeCallableWith();
  expect(Command.keyed).type.not.toBeCallableWith(1);
  expect(Command.keyed).type.not.toBeCallableWith(named, "query");
});

test("a leaf keeps its contextual `A` through `keyed(key, command)`, and loses it through `.pipe`", () => {
  // `Command.keyed(key, command)` puts the leaf in an argument position, where
  // the contextual type of the enclosing call still reaches it.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          Command.keyed(
            "q",
            Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 })),
          ),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // The same leaf through `.pipe` does not: a `.pipe` receiver is checked
  // before the contextual type of the `.pipe` call exists, so `A` falls back to
  // `never` and `dispatch` accepts nothing. A TypeScript rule about receivers,
  // not something this surface can fix — pinned so the two-argument form is
  // never "simplified" away.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          // @ts-expect-error is not assignable to parameter of type 'never'
          Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 })).pipe(Command.keyed("q")),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });
});

test("`Command.restart` names a command and preserves `A` and `R`", () => {
  // Sugar for `batch(cancel(name), keyed(name, command))`, so its type surface
  // mirrors `keyed`'s exactly: pipeable, curried, and two-argument.
  expect(named.pipe(Command.restart("query"))).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  expect(Command.restart("query")(named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  expect(Command.restart("query", named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // The name is required, and it is a string — the same rule as `keyed`.
  expect(Command.restart).type.not.toBeCallableWith();
  expect(Command.restart).type.not.toBeCallableWith(1);
  expect(Command.restart).type.not.toBeCallableWith(named, "query");
});

test("a leaf keeps its contextual `A` through `restart(name, command)`, and loses it through `.pipe`", () => {
  // Same receiver rule as `keyed`: the two-argument form puts the leaf in an
  // argument position, where the enclosing call's contextual type reaches it.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          Command.restart(
            "q",
            Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 })),
          ),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // And `.pipe` severs it, on identical terms — pinned so the two-argument
  // form is never "simplified" away.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          // @ts-expect-error is not assignable to parameter of type 'never'
          Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 })).pipe(
            Command.restart("q"),
          ),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });
});

test("`Command.batch` composes commands and preserves `A` and `R`", () => {
  expect(Command.batch(named, named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // The shape the whole variant exists for: a `Cancel` sequenced ahead of the
  // command replacing it. `Command.cancel` is `Command<never>` when it stands
  // alone, so `A` has to come from the other member rather than collapsing the
  // batch to `never`.
  expect(Command.batch(Command.cancel("X"), named)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService>
  >();

  // Members must agree on the command type; a batch is not a union builder.
  expect(Command.batch).type.not.toBeCallableWith(named, Effect.void);
});

test("a cancel written first in a batch does not pin the batch's `A` to `never`", () => {
  // The regression this exists for, and the reason `cancel` is generic. A
  // concrete `Command<never>` argument outranks the contextual return type as
  // an inference source, so `A` was fixed to `never` before the sibling leaf
  // was checked — and the leaf's `dispatch` accepted nothing. Cancel-first is
  // the only order that means anything, so this is *the* case, not a corner.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          Command.batch(
            Command.cancel("q"),
            Command.keyed(
              "q",
              Command.effect((dispatch) => dispatch({ _tag: "Pong", at: 1 })),
            ),
          ),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // And the emission is still checked against the vocabulary inside a batch —
  // the fix widened where `A` comes from, not what it accepts.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: () =>
        [
          { count: 1 },
          Command.batch(
            Command.cancel("q"),
            // @ts-expect-error is not assignable to type '"Ping" | "Pong"'
            Command.effect((dispatch) => dispatch({ _tag: "Nope" })),
          ),
        ] as const,
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });
});

test("`Command.cancel` addresses one flat group name and emits nothing", () => {
  // `Command<never>`, so a cancel fits any feature's slot without widening it.
  expect(Command.cancel("Search")).type.toBe<Command<never, never>>();

  // Exactly one string. A group is one name in one flat namespace, so the old
  // object forms are compile errors, not a second spelling of the same address.
  expect(Command.cancel).type.not.toBeCallableWith({ tag: "Search" });
  expect(Command.cancel).type.not.toBeCallableWith({ tag: "Search", key: "q" });
  expect(Command.cancel).type.not.toBeCallableWith({ key: "q" });
  expect(Command.cancel).type.not.toBeCallableWith(1);
  expect(Command.cancel).type.not.toBeCallableWith();
});

test("the policy vocabulary and the `Stream` leaf are gone from the surface", () => {
  // Removed with the redesign: concurrency is Effect's, not a second data
  // vocabulary. Asserted by name so a re-introduction has to argue with a test.
  // `restart` is deliberately not in this list — it returned as pure sugar
  // over `batch(cancel, keyed)`, not as a policy.
  expect(Command).type.not.toHaveProperty("ignore");
  expect(Command).type.not.toHaveProperty("queue");
  expect(Command).type.not.toHaveProperty("stream");

  // And the whole constructor set, so a node added without a spec change fails
  // here rather than quietly widening the ADT.
  expect<keyof typeof Command>().type.toBe<
    "none" | "effect" | "keyed" | "batch" | "cancel" | "restart" | "output"
  >();

  // The `Stream` variant is gone from the ADT itself, not merely from the
  // constructors: a long-lived source is `Stream.runForEach` inside the leaf.
  expect<
    Extract<Command<{ readonly _tag: "X" }>, { readonly _tag: "Stream" }>
  >().type.toBe<never>();
  expect<
    Extract<Command<{ readonly _tag: "X" }>, { readonly _tag: "Guarded" }>
  >().type.toBe<never>();
});

test("`Command` is covariant in `A`, so a narrow command satisfies a wide slot", () => {
  // `Command.output(...)` produces `Command<OneTag>` and has to be returnable
  // from a handler whose `Next` expects `Command<Emit<A, O>>`; `Command.none`
  // is `Command<never>` and has to fit everywhere. Both rest on covariance in
  // `A`, which nothing asserted.
  //
  // Pinned deliberately before the command-leaf redesign. Under the callback
  // encoding `A` sits in a doubly-contravariant position, which composes back
  // to covariant — so these assertions should survive that change unchanged,
  // and this is the test that will say so rather than a re-derivation.
  expect<Command<{ readonly _tag: "X" }>>().type.toBeAssignableTo<
    Command<{ readonly _tag: "X" } | { readonly _tag: "Y" }>
  >();

  expect<Command<never>>().type.toBeAssignableTo<Command<{ readonly _tag: "X" }>>();

  // Not the other way: a command emitting the wider union cannot stand in
  // where only `X` is accepted.
  expect<Command<{ readonly _tag: "X" } | { readonly _tag: "Y" }>>().type.not.toBeAssignableTo<
    Command<{ readonly _tag: "X" }>
  >();
});

// ---------------------------------------------------------------------------
// React binding — `createRuntime` → `component`
// ---------------------------------------------------------------------------

declare const fooLayer: Layer.Layer<FooService>;
declare const barFromFoo: Layer.Layer<BarService, never, FooService>;

const OrderPlaced = Action.output("OrderPlaced", { orderId: Schema.String });

const Cart = define({
  props: Schema.Struct({ customerId: Schema.String }),
  state: Schema.Struct({ count: Schema.Number }),
  action: [Action("Added", {})],
  output: [OrderPlaced],
});

const cart = Cart.create({
  initialState: () => ({ count: 0 }),
  reducer: { Added: (_action, snapshot) => snapshot.state },
  render: () => null,
});

test("`component` merges declared props with one required `on<Tag>` prop per output", () => {
  const CartView = createRuntime(Layer.empty).component(cart, { name: "Cart" });

  expect(CartView).type.toBeCallableWith({
    customerId: "c1",
    onOrderPlaced: (payload: { readonly orderId: string }) => void payload.orderId,
  });

  // Required, not optional. This is the whole argument for per-output props
  // over a single `onOutput`: the exhaustiveness check lands at the JSX call
  // site, in every parent, whether or not anyone wrote an exhaustive switch.
  expect(CartView).type.not.toBeCallableWith({ customerId: "c1" });

  // Declared props are still checked, and still required.
  expect(CartView).type.not.toBeCallableWith({ onOrderPlaced: () => {} });

  // `_tag` is stripped from the payload — the prop name already carries it.
  expect<Parameters<Parameters<typeof CartView>[0]["onOrderPlaced"]>[0]>().type.toBe<{
    readonly orderId: string;
  }>();
});

test("`component` is closed over the root's `R`", () => {
  const needsFoo = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: [Action("A", {})],
  }).create({
    initialState: () => ({ count: 0 }),
    reducer: { A: () => [{ count: 1 }, Command.effect(() => fooEffect)] as const },
    render: () => null,
  });

  // The DI guarantee a bare `<Provider>` would throw away: a feature needing a
  // service the root does not provide is a compile error at `component`, not a
  // runtime failure on first dispatch.
  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(needsFoo, {
    name: "NeedsFoo",
  });

  // Positive control, so the rejection above is attributable to `R` rather
  // than to some unrelated mismatch in the feature's shape.
  expect(createRuntime(fooLayer).component).type.toBeCallableWith(needsFoo, { name: "NeedsFoo" });

  // A feature may bring its own layer; the root must cover the residue. `Bar`
  // is supplied here, `Foo` by the root.
  const needsBoth = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: [Action("A", {}), Action("B", {})],
  }).create({
    initialState: () => ({ count: 0 }),
    reducer: {
      A: () => [{ count: 1 }, Command.effect(() => fooEffect)] as const,
      B: () => [{ count: 1 }, Command.effect(() => barEffect)] as const,
    },
    render: () => null,
  });

  expect(createRuntime(fooLayer).component).type.toBeCallableWith(needsBoth, {
    layer: barFromFoo,
    name: "NeedsBoth",
  });

  // The residue is not a free pass: a root providing nothing still fails, because
  // `barFromFoo` itself requires `FooService`.
  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(needsBoth, {
    layer: barFromFoo,
    name: "NeedsBoth",
  });
});

test("a feature's string-keyed surface stays exactly `reduce`, `run` and `subscriptions`", () => {
  // The internals slot `component` reads is symbol-keyed, so it cannot be
  // reached by name from userland and cannot collide with a future method.
  // Asserted on the string keys specifically: a slot added as a plain property
  // would show up here, which is the regression this pins. `subscriptions`
  // is the pure read `subscriptions.specs.md` adds beside `reduce`.
  expect<Extract<keyof typeof cart, string>>().type.toBe<"reduce" | "run" | "subscriptions">();
});

test("`run` reports `defects` beside `emitted` and `outputs`, and stays total", () => {
  const result = cart.run([{ _tag: "Added" }], {
    props: { customerId: "c_1" },
    hooks: {},
    layer: Layer.empty,
  });

  // Total: a dying command lands in `defects`, never in the error channel.
  expect(result).type.toBe<
    Effect.Effect<{
      readonly state: { readonly count: number };
      readonly emitted: ReadonlyArray<{ readonly _tag: "Added" }>;
      readonly outputs: ReadonlyArray<{ readonly _tag: "OrderPlaced"; readonly orderId: string }>;
      readonly defects: ReadonlyArray<RunDefect>;
      readonly subscriptions: ReadonlyArray<string>;
    }>
  >();
});

test("the `Error` handler's payload carries `from` beside `error` and `cause`", () => {
  Cart.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Added: (_action, snapshot) => snapshot.state,
      Error: (payload, snapshot) => {
        expect(payload.from).type.toBe<string>();
        expect(payload.error).type.toBe<unknown>();
        return snapshot.state;
      },
    },
    render: () => null,
  });
});

// ---------------------------------------------------------------------------
// React binding — `component(bp).useFeature`
// ---------------------------------------------------------------------------

test("`useFeature` returns the `RenderSnapshot` typed to the feature", () => {
  const CartView = createRuntime(Layer.empty).component(cart, { name: "Cart" });
  const snapshot = CartView.useFeature();

  expect(snapshot.state).type.toBe<{ readonly count: number }>();
  expect(snapshot.props).type.toBe<{ readonly customerId: string }>();
  expect(snapshot.hooks).type.toBe<{}>();

  // Declared actions and outputs both dispatch — the store routes by tag — and
  // an undeclared tag or a declared tag with the wrong payload does not.
  expect(snapshot.dispatch).type.toBeCallableWith({ _tag: "Added" });
  expect(snapshot.dispatch).type.toBeCallableWith({ _tag: "OrderPlaced", orderId: "o1" });
  expect(snapshot.dispatch).type.not.toBeCallableWith({ _tag: "Removed" });
  expect(snapshot.dispatch).type.not.toBeCallableWith({ _tag: "OrderPlaced" });

  // The whole snapshot is nameable without reconstructing the generics.
  expect<ReturnType<typeof CartView.useFeature>>().type.toBe<
    RenderSnapshot<
      { readonly customerId: string },
      { readonly count: number },
      { readonly _tag: "Added" } | { readonly _tag: "OrderPlaced"; readonly orderId: string },
      {}
    >
  >();
});

test("`useFeature` is on both `component` overloads, and on a feature with no outputs", () => {
  const needsBar = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: [Action("B", {})],
  }).create({
    initialState: () => ({ count: 0 }),
    reducer: { B: () => [{ count: 1 }, Command.effect(() => barEffect)] as const },
    render: () => null,
  });

  const WithLayer = createRuntime(fooLayer).component(needsBar, {
    layer: barFromFoo,
    name: "NeedsBar",
  });
  const Plain = createRuntime(Layer.empty).component(cart, { name: "Cart" });

  expect(WithLayer).type.toHaveProperty("useFeature");
  expect(Plain).type.toHaveProperty("useFeature");

  // No outputs: `dispatch` takes the actions alone, and `never` widens nothing.
  expect(WithLayer.useFeature().dispatch).type.toBeCallableWith({ _tag: "B" });
  expect(WithLayer.useFeature().dispatch).type.not.toBeCallableWith({
    _tag: "OrderPlaced",
    orderId: "o1",
  });
});

test("`component` requires a `name`, on both overloads", () => {
  const { component } = createRuntime(fooLayer);

  // The name is the `useFeature` scope and what survives Fast Refresh, so it
  // is not optional and has no default.
  expect(component).type.toBeCallableWith(cart, { name: "Cart" });
  expect(component).type.not.toBeCallableWith(cart);
  expect(component).type.not.toBeCallableWith(cart, {});
  expect(component).type.not.toBeCallableWith(cart, { name: undefined });

  // `layer` alone does not select the second overload without a name either.
  const needsBar = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ count: Schema.Number }),
    action: [Action("B", {})],
  }).create({
    initialState: () => ({ count: 0 }),
    reducer: { B: () => [{ count: 1 }, Command.effect(() => barEffect)] as const },
    render: () => null,
  });
  expect(component).type.toBeCallableWith(needsBar, { layer: barFromFoo, name: "NeedsBar" });
  expect(component).type.not.toBeCallableWith(needsBar, { layer: barFromFoo });
});

test("`FeatureComponent` is still an `FC`, so JSX and `FC`-typed slots accept it", () => {
  const CartView = createRuntime(Layer.empty).component(cart, { name: "Cart" });

  expect(CartView).type.toBeAssignableTo<FC<ComponentProps<typeof CartView>>>();
  expect(CartView).type.toBeAssignableTo<
    FeatureComponent<
      { readonly customerId: string },
      { readonly count: number },
      { readonly _tag: "Added" },
      { readonly _tag: "OrderPlaced"; readonly orderId: string },
      {}
    >
  >();

  // The added member changes nothing about what JSX accepts.
  expect(CartView).type.toBeCallableWith({
    customerId: "c1",
    onOrderPlaced: (payload: { readonly orderId: string }) => void payload.orderId,
  });
  expect(CartView).type.not.toBeCallableWith({ customerId: "c1" });
});

// ---------------------------------------------------------------------------
// Lazy commands — `[state, (next) => command]`
// ---------------------------------------------------------------------------

test("a lazy command is handed the tuple's state and keeps the contextual `A`", () => {
  // Same rule as the leaf: `A` arrives from the handler's return type, one
  // function deeper. Direct calls, not `toBeCallableWith`, for the reason
  // given at the leaf's own test.
  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: (_action, { state }) => [
        { count: state.count + 1 },
        (next) => {
          expect(next).type.toBe<{ readonly count: number }>();
          return Command.effect((dispatch) => dispatch({ _tag: "Pong", at: next.count }));
        },
      ],
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: (_action, { state }) => [
        { count: state.count + 1 },
        // @ts-expect-error is not assignable to type '"Ping" | "Pong"'
        (next) => Command.effect((dispatch) => dispatch({ _tag: "Nope", at: next.count })),
      ],
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });
});

test("a lazy command over a narrower tuple state still fits `Next<State>`", () => {
  // The common shape in practice: spreading into an optional field makes the
  // tuple's state narrower than `State`. The whole tuple still satisfies the
  // handler's return type — which is the bivariance `LazyCommand` is declared
  // with. The thunk's parameter is contextually typed as `State`, not the
  // narrower literal: the contextual type is the handler's return, which
  // knows nothing of this tuple. (`Task.start` infers from its first argument
  // and does narrow — see the task type tests.)
  const Optional = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ picked: Schema.optional(Schema.String) }),
    action: [Action("Pick", { id: Schema.String }), Action("Seen", {})],
  });

  Optional.create({
    initialState: () => ({}),
    reducer: {
      Pick: (action, { state }) => [
        { ...state, picked: action.id },
        (next) => {
          expect(next.picked).type.toBe<string | undefined>();
          return Command.effect((dispatch) => dispatch({ _tag: "Seen" }));
        },
      ],
      Seen: (_action, { state }) => state,
    },
    render: () => null,
  });
});

test("`ServicesOf` reads `R` through a lazy command", () => {
  const lazyFoo = Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: (_action, { state }) => [state, () => Command.effect(() => fooEffect)],
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  // The DI guarantee holds one function deeper: the service the thunk's
  // command needs is still a compile error at `component`.
  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(lazyFoo, {
    name: "LazyFoo",
  });
  expect(createRuntime(fooLayer).component).type.toBeCallableWith(lazyFoo, { name: "LazyFoo" });
});

test("`Next.lazy` infers the tuple state from its first argument and fits the handler's `Next`", () => {
  const Optional = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ picked: Schema.optional(Schema.String) }),
    action: [Action("Pick", { id: Schema.String }), Action("Seen", {})],
  });

  Optional.create({
    initialState: () => ({}),
    reducer: {
      Pick: (action, { state }) =>
        Next.lazy({ ...state, picked: action.id }, (next) => {
          // Unlike the bare tuple, the thunk sees the narrowed state it was
          // built from: `picked` is a `string` here.
          expect(next.picked).type.toBe<string>();
          return Command.effect((dispatch) => dispatch({ _tag: "Seen" }));
        }),
      Seen: (_action, { state }) => state,
    },
    render: () => null,
  });

  const lazy = Next.lazy({ count: 1 }, () => named);
  expect(lazy).type.toBe<
    readonly [
      { count: number },
      LazyCommand<{ count: number }, { readonly _tag: "X" }, PipeableFooService>,
    ]
  >();
  expect(Next.command(lazy)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService> | undefined
  >();
});

test("`ServicesOf` reads `R` through `Next.lazy`", () => {
  const lazyFoo = Contextual.create({
    initialState: () => ({ count: 0 }),
    reducer: {
      Ping: (_action, { state }) => Next.lazy(state, () => Command.effect(() => fooEffect)),
      Pong: (_action, snapshot) => snapshot.state,
    },
    render: () => null,
  });

  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(lazyFoo, {
    name: "LazyFoo",
  });
  expect(createRuntime(fooLayer).component).type.toBeCallableWith(lazyFoo, { name: "LazyFoo" });
});

test("`Next.command` resolves a lazy command to the command type", () => {
  const state: { readonly count: number } = { count: 1 };
  const lazy = [state, (_next: { readonly count: number }) => named] as const;

  expect(Next.command(lazy)).type.toBe<
    Command<{ readonly _tag: "X" }, PipeableFooService> | undefined
  >();
});

// ---------------------------------------------------------------------------
// snapshot.draft
// ---------------------------------------------------------------------------

const Todo = Schema.Struct({ id: Schema.String, done: Schema.Boolean });
const Toggled = Action("Toggled", { id: Schema.String });
const Ping = Action("Ping", {});
const Drafting = define({
  props: Schema.Struct({ listId: Schema.String }),
  state: Schema.Struct({
    todos: Schema.Array(Todo),
    opt: Schema.Option(Schema.Number),
    load: Task.schema(Schema.String),
  }),
  action: [Toggled, Ping],
});

test("`snapshot.draft` is a mutable `Draft<State>` that keeps the key set", () => {
  Drafting.create({
    initialState: () => ({ todos: [], opt: Option.none(), load: Task.idle }),
    reducer: {
      Toggled: ({ id }, { draft, state, props }) => {
        expect(draft).type.toBe<Draft<typeof state>>();
        // Arrays and plain objects lose `readonly`, recursively.
        expect(draft.todos).type.toBe<Array<{ id: string; done: boolean }>>();
        draft.todos.push({ id, done: false });
        draft.todos[0].done = true;
        // An Effect data type passes through: same type, still immutable.
        expect(draft.opt).type.toBe<Option.Option<number>>();
        // The read-only snapshot beside it is untouched.
        expect(state.todos).type.toBe<
          ReadonlyArray<{ readonly id: string; readonly done: boolean }>
        >();
        expect(props).type.toBe<{ readonly listId: string }>();
        // A draft is a `State`, so it is a valid `Next` alone or in a tuple.
        return draft;
      },
      Ping: (_action, { draft }) => [draft, Command.none],
    },
    render: () => null,
  });

  // A wrong shape on the draft is the same error a wrong shape on a spread is.
  Drafting.create({
    initialState: () => ({ todos: [], opt: Option.none(), load: Task.idle }),
    reducer: {
      Toggled: (_action, { draft }) => {
        // @ts-expect-error 'string' is not assignable to type 'boolean'
        draft.todos[0].done = "yes";
        return draft;
      },
      Ping: (_action, { draft }) => draft,
    },
    render: () => null,
  });
});

test("`Task.start` and `Next.lazy` accept a draft, and `Exhaustive` sees no excess", () => {
  const load = Task("Load", { success: Schema.String, onError: Task.errorMessage });
  const WithTask = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ todos: Schema.Array(Todo), load: Task.schema(Schema.String) }),
    action: [Toggled, ...load.actions],
  });

  // Direct calls, not `toBeCallableWith`: the handlers need the contextual
  // types the object literal gets only as a real argument.
  WithTask.create({
    initialState: () => ({ todos: [], load: Task.idle }),
    reducer: {
      Toggled: (_action, { draft }) => Task.start(draft, "load", load.run(Effect.succeed("x"))),
      ...load.into("load"),
    },
    render: () => null,
  });

  WithTask.create({
    initialState: () => ({ todos: [], load: Task.idle }),
    reducer: {
      Toggled: (_action, { draft }) =>
        Next.lazy(draft, (next) => {
          expect(next).type.toBe<
            Draft<{
              readonly todos: ReadonlyArray<{ readonly id: string; readonly done: boolean }>;
              readonly load: TaskValue<string, string>;
            }>
          >();
          return Command.none;
        }),
      ...load.into("load"),
    },
    render: () => null,
  });

  // The key must still be a task field of the draft.
  WithTask.create({
    initialState: () => ({ todos: [], load: Task.idle }),
    reducer: {
      // @ts-expect-error '"todos"' is not assignable to parameter of type '"load"'
      Toggled: (_action, { draft }) => Task.start(draft, "todos", load.run(Effect.succeed("x"))),
      ...load.into("load"),
    },
    render: () => null,
  });
});

test("`Task.resolved` of a readonly array lands in a drafted field and in the state", () => {
  const load = Task("Load", { success: Schema.Array(Todo), onError: Task.errorMessage });
  const Loading = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ load: Task.schema(Schema.Array(Todo)) }),
    action: [...load.actions],
  });

  Loading.create({
    initialState: () => ({ load: Task.idle }),
    reducer: {
      // `value` is `ReadonlyArray<…>`; the drafted field is `Array<…>`.
      LoadResolved: ({ value }, { draft }) => {
        expect(value).type.toBe<ReadonlyArray<{ readonly id: string; readonly done: boolean }>>();
        draft.load = Task.resolved(value);
        return draft;
      },
      LoadRejected: ({ error }, { state }) => ({ ...state, load: Task.rejected(error) }),
    },
    render: () => null,
  });
});

test("a command beside a draft still carries `R` to `component`", () => {
  const needsFooDraft = Drafting.create({
    initialState: () => ({ todos: [], opt: Option.none(), load: Task.idle }),
    reducer: {
      Toggled: (_action, { draft }) => [draft, Command.effect(() => fooEffect)],
      Ping: (_action, { draft }) => draft,
    },
    render: () => null,
  });

  expect(createRuntime(Layer.empty).component).type.not.toBeCallableWith(needsFooDraft, {
    name: "NeedsFooDraft",
  });
  expect(createRuntime(fooLayer).component).type.toBeCallableWith(needsFooDraft, {
    name: "NeedsFooDraft",
  });
});

test("`render` and `subscriptions` see no draft", () => {
  Drafting.create({
    initialState: () => ({ todos: [], opt: Option.none(), load: Task.idle }),
    reducer: {
      Toggled: (_action, { draft }) => draft,
      Ping: (_action, { draft }) => draft,
    },
    render: (snapshot) => {
      expect(snapshot).type.not.toHaveProperty("draft");
      return null;
    },
    subscriptions: (snapshot) => {
      expect(snapshot).type.not.toHaveProperty("draft");
      return {};
    },
  });
});

test("`reduce` takes an optional drafter; the `Drafter` service is a `Reference`", () => {
  const feature = Drafting.create({
    initialState: () => ({ todos: [], opt: Option.none(), load: Task.idle }),
    reducer: {
      Toggled: (_action, { draft }) => draft,
      Ping: (_action, { draft }) => draft,
    },
    render: () => null,
  });
  const snapshot = { state: feature.reduce, props: { listId: "l" }, hooks: {} } as never;

  expect(feature.reduce).type.toBeCallableWith(Toggled.make({ id: "a" }), snapshot);
  expect(feature.reduce).type.toBeCallableWith(
    Toggled.make({ id: "a" }),
    snapshot,
    mutativeDrafter,
  );
  // Installing one widens nothing: a `Reference` layer has no requirement.
  expect(drafterLayer(mutativeDrafter)).type.toBe<Layer.Layer<never>>();
});
