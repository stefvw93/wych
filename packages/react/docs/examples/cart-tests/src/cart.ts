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

// `tasks: { charge }` gives the task the `charge` state field: it starts
// `Idle`, `start` writes `Pending`, and the fold writes the settle into it.
export const cart = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ items: Schema.Array(Item) }),
  tasks: { charge },
  actions,
  outputs: Ordered,
}).create({
  initialState: () => ({ items: [] }),
  reducer: {
    Added: (item, { draft }) => {
      draft.items.push(item);
      return draft;
    },
    Submitted: (_payload, { state, tasks }) => tasks.charge.start(total(state.items)),
    // The receipt is already in `charge` when this runs; announce the order beside it.
    ChargeResolved: (_receipt, { state }) => [
      state,
      Command.output(Ordered, { total: total(state.items) }),
    ],
  },
  render: () => null,
});
