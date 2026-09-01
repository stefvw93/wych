import { consoleDevtoolsLayer, createRuntime } from "@wych/react";
import { Context, Effect, Layer } from "effect";

export class Api extends Context.Service<Api, { readonly load: Effect.Effect<string> }>()("Api") {}

export const app = Layer.succeed(Api)({ load: Effect.succeed("ok") });

const devtools = import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty;

export const { component } = createRuntime(Layer.mergeAll(app, devtools));
