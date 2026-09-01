import { createRuntime } from "@wych/react";
import { Effect, Layer } from "effect";
import { createRoot } from "react-dom/client";
import { everySearch, searchFeature, taskSearch, Typed } from "./search";
import { SearchApi } from "./search-api";

// A slow stub, so "Searching" is visible and take-latest has something to interrupt.
const api = Layer.succeed(SearchApi)({
  hits: (query) => Effect.sleep("500 millis").pipe(Effect.as([`${query} result`])),
});

const { component } = createRuntime(api);

const DebouncedSearch = component(searchFeature, { name: "DebouncedSearch" });
const Search = component(taskSearch, { name: "Search" });

const App = () => (
  <main>
    <h2>Debounce inside the command</h2>
    <DebouncedSearch />
    <h2>Take latest with a task</h2>
    <Search />
  </main>
);

createRoot(document.getElementById("root")!).render(<App />);

// Compare "latest" and "every" without React. Open the console.
const slowApi = Layer.succeed(SearchApi)({
  hits: (query) => Effect.sleep("50 millis").pipe(Effect.as([`${query}!`])),
});

const keystrokes = [Typed.make({ query: "a" }), Typed.make({ query: "ab" })];
const options = { props: {}, hooks: {}, layer: slowApi };

const latest = await Effect.runPromise(taskSearch.run(keystrokes, options));
console.log(latest.emitted);
// => [{ _tag: "SearchResolved", value: ["ab!"] }]

const every = await Effect.runPromise(everySearch.run(keystrokes, options));
console.log(every.emitted);
// => [
//      { _tag: "SearchEveryResolved", value: ["a!"] },
//      { _tag: "SearchEveryResolved", value: ["ab!"] },
//    ]
