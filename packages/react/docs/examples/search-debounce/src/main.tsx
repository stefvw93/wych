import { createRuntime } from "@wych/react";
import { Effect, Layer } from "effect";
import { createRoot } from "react-dom/client";
import { pagedSearch, searchFeature, taskSearch } from "./search";
import { SearchApi } from "./search-api";

// A slow stub, so "Searching" is visible and take-latest has something to interrupt.
const api = Layer.succeed(SearchApi)({
  hits: (query, page = 1) =>
    Effect.sleep("500 millis").pipe(Effect.as([`${query} result, page ${page}`])),
});

const { component } = createRuntime(api);

const DebouncedSearch = component(searchFeature, { name: "DebouncedSearch" });
const Search = component(taskSearch, { name: "Search" });
const PagedSearch = component(pagedSearch, { name: "PagedSearch" });

const App = () => (
  <main>
    <h2>Debounce inside the command</h2>
    <DebouncedSearch />
    <h2>Take latest with a task</h2>
    <Search />
    <h2>Load the next page</h2>
    <PagedSearch />
  </main>
);

createRoot(document.getElementById("root")!).render(<App />);
