import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import * as Resource from "@effect/opentelemetry/Resource";
import { context, trace } from "@opentelemetry/api";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { site } from "@/lib/site";

/**
 * Effect spans go to the OpenTelemetry provider `instrumentation.ts`
 * registered, so they nest under Next's request span and leave through
 * Vercel's exporter. Without a provider (tests, a bare build) the global one
 * is a no-op and so are the spans.
 */
const TracingLive = OtelTracer.layerGlobal.pipe(
  Layer.provide(Resource.layer({ serviceName: site.serviceName })),
);

/** One runtime for the process; every server-side Effect runs through it. */
export const runtime = ManagedRuntime.make(TracingLive);

/**
 * Run a server-side Effect for a caller that speaks Promise: a route handler
 * or a server component.
 *
 * The caller's OpenTelemetry span is read here, synchronously, and handed to
 * the fiber as its parent. Fibers resume inside a scheduler tick shared by the
 * whole process, so the async context there is whichever request last
 * scheduled work, not this one; reading it at span creation would parent the
 * span wrongly or not at all.
 */
export const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const parent = trace.getSpan(context.active())?.spanContext();
  return runtime.runPromise(
    parent === undefined ? effect : OtelTracer.withSpanContext(effect, parent),
  );
};
