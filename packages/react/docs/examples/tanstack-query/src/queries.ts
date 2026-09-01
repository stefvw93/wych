import type { QueryClient } from "@tanstack/react-query";
import { Context } from "effect";

/**
 * The QueryClient as an Effect service. The same instance goes to
 * `QueryClientProvider` for hooks and to the runtime layer for commands, so
 * a command that invalidates a key refetches every `useQuery` on it.
 */
export class Queries extends Context.Service<Queries, QueryClient>()("Queries") {}
