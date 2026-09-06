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
const page = renderToString(
  <Provider>
    <Counter start={7} />
  </Provider>,
);
console.log(page);

// 2. "Client": hydrate the same feature over the server markup. The first
// client render paints `initialState(props)` again, so it matches the HTML.
// `Mounted` folds after commit and its command bumps the count to 6.
const errors: string[] = [];
const root = document.getElementById("root")!;
root.innerHTML = html; // what the server sent
hydrateRoot(root, <Counter start={5} />, {
  onRecoverableError: (error) => errors.push(String(error)),
});

await new Promise((resolve) => setTimeout(resolve, 50)); // let the mount effect run
console.log("after hydration", counts());
// => [1, 1]
console.log(root.querySelector("span")?.textContent);
// => "6"
console.log(errors);
// => []

// 3. The mismatch: hydrate markup painted from start={5} with start={6}.
// React discards the server markup and regenerates the tree on the client.
const mismatched = document.createElement("div");
document.body.appendChild(mismatched);
mismatched.innerHTML = html; // painted from start={5}
hydrateRoot(mismatched, <Counter start={6} />, {
  onRecoverableError: (error) => errors.push(String(error)),
});

await new Promise((resolve) => setTimeout(resolve, 50));
console.log(errors.map((message) => message.split(".")[0]));
// => ["Error: Hydration failed because the server rendered text didn't match the client"]
console.log(mismatched.querySelector("span")?.textContent);
// => "7"
