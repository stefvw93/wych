import { Effect, Layer } from "effect";
import { createRoot } from "react-dom/client";
import { Bumped, Counter, counter } from "./counter";

createRoot(document.getElementById("root")!).render(
  <Counter step={5} onReached={({ at }) => console.log("Reached", at)} />,
);

// The same feature, folded without React. Open the console.
const result = await Effect.runPromise(
  counter.run([Bumped.make({}), Bumped.make({})], {
    props: { step: 5 },
    hooks: {},
    layer: Layer.empty,
  }),
);
console.log(result.state);
// => { count: 15 }
console.log(result.outputs);
// => [{ _tag: "Reached", at: 10 }, { _tag: "Reached", at: 15 }]
