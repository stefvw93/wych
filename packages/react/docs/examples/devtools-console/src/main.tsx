import { createRoot } from "react-dom/client";
import { Counter } from "./counter";

createRoot(document.getElementById("root")!).render(
  <main>
    <p>Open the console, then press the button.</p>
    <Counter />
  </main>,
);
