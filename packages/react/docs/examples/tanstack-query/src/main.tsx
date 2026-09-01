import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRuntime } from "@wych/react";
import { Layer } from "effect";
import { createRoot } from "react-dom/client";
import { fetchNote } from "./api";
import { noteEditor, noteKey } from "./note-editor";
import { Queries } from "./queries";

// One QueryClient, handed to both React (hooks) and Effect (commands).
const queryClient = new QueryClient();
const { component } = createRuntime(Layer.succeed(Queries)(queryClient));

const NoteEditor = component(noteEditor, { name: "NoteEditor" });

/** A plain TanStack consumer on the same key. It refetches after every save. */
const Preview = ({ noteId }: { noteId: string }) => {
  const { data, isFetching } = useQuery({
    queryKey: noteKey(noteId),
    queryFn: () => fetchNote(noteId),
  });
  return (
    <p>
      {data?.text ?? "…"} {isFetching && <em>(refreshing)</em>}
    </p>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <main>
      <h2>Editor</h2>
      <NoteEditor noteId="n1" onSaved={({ id }) => console.log("saved", id)} />
      <h2>Preview, via useQuery</h2>
      <Preview noteId="n1" />
    </main>
  </QueryClientProvider>
);

createRoot(document.getElementById("root")!).render(<App />);
