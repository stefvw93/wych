import { createRuntime } from "@wych/react";
import { Effect, Layer } from "effect";
import { createRoot } from "react-dom/client";
import { searchFeature, taskSearch } from "./search";
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
