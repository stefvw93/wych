import { registerOTel } from "@vercel/otel";
import { site } from "@/lib/site";

/**
 * Installs the global OpenTelemetry provider and Vercel's exporter. Effect
 * spans join it through `lib/tracing.ts`, which is Node-only and so must not
 * be imported here: `register` also runs in the edge runtime.
 */
export function register() {
  registerOTel({ serviceName: site.serviceName });
}
