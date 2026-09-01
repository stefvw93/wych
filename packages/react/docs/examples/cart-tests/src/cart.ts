import { Action, Command, define, Task } from "@wych/react";
import { Context, Effect, Schema } from "effect";

const Item = Schema.Struct({ id: Schema.String, price: Schema.Number });

export class Payments extends Context.Service<
  Payments,
  { readonly charge: (total: number) => Effect.Effect<string, Error> }
>()("Payments") {}

export const Added = Action("Added", { id: Schema.String, price: Schema.Number });
export const Submitted = Action("Submitted", {});
const Ordered = Action.output("Ordered", { total: Schema.Number });

const charge = Task("Charge", {
  success: Schema.String,
  onError: Task.message,
  run: (total: number) => Effect.flatMap(Payments, (api) => api.charge(total)),
});

const total = (items: ReadonlyArray<{ readonly price: number }>) =>
  items.reduce((sum, item) => sum + item.price, 0);

export const cart = define({
  props: Schema.Struct({}),
  state: Schema.Struct({
    items: Schema.Array(Item),
    charge: Task.schema(Schema.String),
  }),
  action: Action.of([Added, Submitted, ...charge.actions]),
  output: Action.of([Ordered]),
}).create({
  initialState: () => ({ items: [], charge: Task.idle }),
  reducer: {
    Added: (item, { state }) => ({ ...state, items: [...state.items, item] }),
    Submitted: (_payload, { state }) => Task.start(state, "charge", charge.run(total(state.items))),
    ChargeResolved: ({ value }, { state }) => [
      { ...state, charge: Task.resolved(value) },
      Command.output(Ordered, { total: total(state.items) }),
    ],
    ChargeRejected: ({ error }, { state }) => ({ ...state, charge: Task.rejected(error) }),
  },
  render: () => null,
});
