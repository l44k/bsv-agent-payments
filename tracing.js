// tracing.js
// OpenTelemetry setup. Load it before anything else:
//   node -r ./tracing.js agent-server.js
// Tracing is on only when OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://jaeger:4318);
// otherwise this file does nothing. HTTP servers and fetch() calls are traced
// automatically, and the trace context travels between agents in the
// `traceparent` HTTP header, so one task becomes one trace across all containers.

const { NodeSDK } = require('@opentelemetry/sdk-node')
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici')
const { resourceFromAttributes } = require('@opentelemetry/resources')

const routeName = (method, url) => `${method} ${String(url || '/').split('?')[0] || '/'}`

let sdk = null

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // Traces only: Jaeger does not accept metrics or logs, and the SDK would otherwise
  // try to send them to the same endpoint and fill the container logs with errors.
  if (!process.env.OTEL_METRICS_EXPORTER) process.env.OTEL_METRICS_EXPORTER = 'none'
  if (!process.env.OTEL_LOGS_EXPORTER) process.env.OTEL_LOGS_EXPORTER = 'none'
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || process.env.AGENT_ID || 'consumer' }),
    traceExporter: new OTLPTraceExporter(), // sends to $OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces
    // Name HTTP spans after the route ("POST /quote") instead of just the method ("POST").
    // Our paths carry no ids (those are in the JSON body), so this stays low-cardinality.
    instrumentations: [
      new HttpInstrumentation({ requestHook: (span, req) => { if (req.method) span.updateName(routeName(req.method, req.url || req.path)) } }),
      new UndiciInstrumentation({ requestHook: (span, req) => span.updateName(routeName(req.method, req.path)) }) // undici = Node's fetch
    ]
  })
  sdk.start()
  const stop = () => sdk.shutdown().finally(() => process.exit(0))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

// Flush spans before a short-lived process (the consumer) exits.
async function shutdownTracing() {
  if (sdk) await sdk.shutdown().catch(() => {})
}

module.exports = { shutdownTracing }
