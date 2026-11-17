import { resourceFromAttributes } from "@opentelemetry/resources";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
let provider: TracerProvider | undefined;
export function configureTracing(service: string) {
  const raw = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!raw || provider) return;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" &&
    !(
      process.env.FV_ENV === "local" &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw new Error("secure trace collector required");
  provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": `fv-${service}` }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({ url: url.href, timeoutMillis: 3000 }),
        maxQueueSize: 512,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 5000,
      }),
    ],
  });
  trace.setGlobalTracerProvider(provider);
}
export function span(
  name: string,
  attributes: Record<string, string | number>,
): Span {
  return trace
    .getTracer("founder-village-runtime", "0.1.0")
    .startSpan(name, { attributes });
}
export function finish(value: Span, status: number) {
  value.setAttribute("http.response.status_code", status);
  value.setStatus({
    code: status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  });
  value.end();
}
export async function flushTracing() {
  await provider?.shutdown();
}
