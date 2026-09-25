import { Action, Command, define, Task } from "@wych/react";
import { Context, Effect, Schema } from "effect";

const Item = Schema.Struct({ id: Schema.String, price: Schema.Number });

export class Payments extends Context.Service<
  Payments,
  { readonly charge: (total: number) => Effect.Effect<string, Error> }
>()("Payments") {}

export const actions = Action({
  Added: { id: Schema.String, price: Schema.Number },
  Submitted: {},
});
const Ordered = Action.output("Ordered", { total: Schema.Number });

const charge = Task("Charge", {
  success: Schema.String,
  run: (total: number) =>
    Effect.gen(function* () {
      const api = yield* Payments;
      return yield* api.charge(total);
    }),
});

const total = (items: ReadonlyArray<{ readonly price: number }>) =>
  items.reduce((sum, item) => sum + item.price, 0);

export const cart = define({
  props: Schema.Struct({}),
  state: Schema.Struct({
    items: Schema.Array(Item),
    charge: charge.schema,
  }),
  actions: [actions, charge],
  outputs: Ordered,
}).create({
  initialState: () => ({ items: [], charge: Task.idle }),
  reducer: {
    Added: (item, { draft }) => {
      draft.items.push(item);
      return draft;
    },
    Submitted: (_payload, { draft }) => Task.start(draft, "charge", charge.run(total(draft.items))),
    ...charge.into("charge"),
    ChargeResolved: charge.resolvedInto("charge", (_receipt, { draft, state }) => [
      draft,
      Command.output(Ordered, { total: total(state.items) }),
    ]),
  },
  render: () => null,
});
