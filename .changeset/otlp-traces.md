---
"@bunvex/server": minor
"@bunvex/core": minor
---

Traces over OpenTelemetry (STUDY-131 AD-26, beyond Convex): with `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) set, the server exports spans over OTLP/HTTP JSON to Jaeger, Tempo, Honeycomb or any OTLP receiver. One trace per HTTP request or WebSocket message: the function run (path, kind, cache hit, documents and bytes read), its index reads (one span per index), its commit (wait, validate, write), the sync transition and the queries it re-ran; scheduled jobs and cron runs are traces of their own. A `traceparent` header continues the caller's trace. Configured by the OpenTelemetry SDK's variables (`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_BSP_*`), or the `tracing` server option. Off by default, at no measurable cost; `/stats` reports the spans exported, dropped and failed.
