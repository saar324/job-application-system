import { metrics, trace, SpanStatusCode } from "@opentelemetry/api";

const SENSITIVE = /password|passwd|secret|token|cookie|authorization|answer|resume|document|content|body/i;

export function safeAttributes(attributes = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SENSITIVE.test(key)) continue;
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    safe[key] = typeof value === "string" ? value.slice(0, 240) : value;
  }
  return safe;
}

export class Telemetry {
  constructor(name = "job-application-system") {
    this.tracer = trace.getTracer(name);
    this.meter = metrics.getMeter(name);
    this.counters = new Map();
    this.histograms = new Map();
    this.otelCounters = new Map();
    this.otelHistograms = new Map();
  }

  count(name, value = 1, attributes = {}) {
    const amount = Number(value) || 0;
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
    let counter = this.otelCounters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.otelCounters.set(name, counter);
    }
    counter.add(amount, safeAttributes(attributes));
  }

  observe(name, value, attributes = {}) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return;
    const current = this.histograms.get(name) ?? { count: 0, sum: 0, max: 0 };
    current.count += 1;
    current.sum += amount;
    current.max = Math.max(current.max, amount);
    this.histograms.set(name, current);
    let histogram = this.otelHistograms.get(name);
    if (!histogram) {
      histogram = this.meter.createHistogram(name);
      this.otelHistograms.set(name, histogram);
    }
    histogram.record(amount, safeAttributes(attributes));
  }

  async span(name, attributes, fn) {
    return this.tracer.startActiveSpan(name, { attributes: safeAttributes(attributes) }, async (span) => {
      const started = performance.now();
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error.message ?? "error").slice(0, 240) });
        throw error;
      } finally {
        this.observe(`${name}.duration_ms`, performance.now() - started, attributes);
        span.end();
      }
    });
  }

  health() {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries([...this.histograms].map(([key, value]) => [key, {
        ...value, average: value.count ? value.sum / value.count : 0
      }]))
    };
  }
}

export const telemetry = new Telemetry();
