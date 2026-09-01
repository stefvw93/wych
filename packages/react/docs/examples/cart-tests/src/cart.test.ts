import { createRecorder, createRuntime, devtoolsLayer, Next, Task } from "@wych/react";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { Added, cart, Payments, Submitted } from "./cart";

// --- one step with reduce ---------------------------------------------------

const empty = { items: [], charge: Task.idle } as const;

test("Added appends and issues no command", () => {
  const next = cart.reduce(Added.make({ id: "a", price: 10 }), {
    state: empty,
    props: {},
    hooks: {},
  });

  expect(Next.state(next).items).toEqual([{ id: "a", price: 10 }]);
  expect(Next.command(next)).toBeUndefined();
});

test("Submitted writes Pending and issues a command", () => {
  const next = cart.reduce(Submitted.make({}), {
    state: { items: [{ id: "a", price: 10 }], charge: Task.idle },
    props: {},
    hooks: {},
  });

  expect(Next.state(next).charge).toEqual({ _tag: "Pending" });
  expect(Next.command(next)).toBeDefined();
});

// --- a sequence with run ----------------------------------------------------

const paid = Layer.succeed(Payments)({
  charge: (amount) => Effect.succeed(`receipt-${amount}`),
});

test("a paid cart resolves the task and announces the order", async () => {
  const { state, emitted, outputs } = await Effect.runPromise(
    cart.run([Added.make({ id: "a", price: 10 }), Submitted.make({})], {
      props: {},
      hooks: {},
      layer: paid,
    }),
  );

  expect(state.charge).toEqual({ _tag: "Resolved", value: "receipt-10" });
  expect(emitted).toEqual([{ _tag: "ChargeResolved", value: "receipt-10" }]);
  expect(outputs).toEqual([{ _tag: "Ordered", total: 10 }]);
});

// --- supply a test layer ----------------------------------------------------

const declined = Layer.succeed(Payments)({
  charge: () => Effect.fail(new Error("card declined")),
});

test("a declined charge rejects the task and announces nothing", async () => {
  const { state, outputs } = await Effect.runPromise(
    cart.run([Added.make({ id: "a", price: 10 }), Submitted.make({})], {
      props: {},
      hooks: {},
      layer: declined,
    }),
  );

  expect(state.charge).toEqual({ _tag: "Rejected", error: "card declined" });
  expect(outputs).toEqual([]);
});

// --- assert on the devtools stream ------------------------------------------

const recorder = createRecorder();
const { component } = createRuntime(Layer.mergeAll(paid, devtoolsLayer(recorder.sink)));
export const Cart = component(cart, { name: "Cart" });

test("the recorder starts empty", () => {
  expect(recorder.events).toEqual([]);
  recorder.clear();
});

test("transitions are filterable by tag", () => {
  const transitions = recorder.events.filter((event) => event._tag === "Transition");
  expect(transitions).toEqual([]);
});
