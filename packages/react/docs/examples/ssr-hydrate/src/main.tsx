import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { Counter, Provider, counts } from "./counter";

// 1. "Server": paint the initial state. Nothing folds, no command runs.
const html = renderToString(<Counter start={5} />);
console.log(html);
console.log("after renderToString", counts());
// => [0, 0]

// Props are validated on the server too.
const bad = { start: "not a number" } as unknown as { readonly start: number };
try {
  renderToString(<Counter {...bad} />);
} catch (error) {
  console.log(String(error));
  // => TypeError: Invalid props for <Counter>
}

// `Provider` changes nothing about what folds.
console.log(
  renderToString(
    <Provider>
      <Counter start={7} />
    </Provider>,
  ),
);

// 2. "Client": hydrate the same feature over the server markup.
const root = document.getElementById("root")!;
root.innerHTML = html; // what the server sent
hydrateRoot(root, <Counter start={5} />);

setTimeout(() => {
  console.log("after hydration", counts());
  // => [1, 1]
}, 50);
