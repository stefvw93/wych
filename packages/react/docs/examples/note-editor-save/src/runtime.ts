import { createRuntime } from "@wych/react";
import { notesApiLayer } from "./notes-api";

export const { component } = createRuntime(notesApiLayer);
