// spans.js
// Small helper for our own business spans (negotiate, pay, verify, LLM call).
// Without a configured SDK (tracing.js not loaded or no endpoint) these are no-ops.

const { trace, SpanStatusCode } = require('@opentelemetry/api')

const tracer = trace.getTracer('bsv-agent-demo')

async function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async span => {
    try {
      return await fn(span)
    } catch (err) {
      span.recordException(err)
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
      throw err
    } finally {
      span.end()
    }
  })
}

module.exports = { withSpan }
