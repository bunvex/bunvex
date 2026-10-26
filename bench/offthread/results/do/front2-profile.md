## sqlite-cached

7025 req/s, p99 161.9 ms, errors 0.00%, server 1.70 cores (bun 0.94, Worker 0.58, HeapHelper 0.05, thread 0.05, JITWorker 0.04, mi-scavenger 0.03)

main thread busy 17.82 s of 22.21 s, 140565 requests, 126.8 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| request path: routing and server | 37.2% | 47.1 | fetch 12.4%, Response [native] 8.1%, capped 2.5%, (anonymous) 2.2% |
| prototype: thread messages | 21.8% | 27.7 | postMessage [native] 12.7%, Request [native] 3.7%, (anonymous) 2.2%, next [native] 2.1% |
| request path: function dispatch | 11.0% | 13.9 | loggedRun 1.0%, registryKey 1.0%, stringify [native] 0.8%, randomUUID [native] 0.8% |
| request path: function log | 7.2% | 9.1 | nextUp 1.5%, append 1.0%, withOwner 0.8%, collectLogs 0.7% |
| engine: transactions | 5.9% | 7.5 | cachedQuery 1.2%, setTimeout [native] 0.9%, (anonymous) 0.6%, stillValid 0.5% |
| request path: metrics and tracing | 3.7% | 4.7 | add 1.7%, recordExecution 0.6%, indexFor 0.6%, execution 0.4% |
| request path: CORS | 3.6% | 4.5 | set [native] 1.0%, (anonymous) 0.9%, withCors 0.8%, get [native] 0.3% |
| values | 2.2% | 2.8 | entries [native] 0.8%, toJson 0.4%, fromJson 0.4%, identifierError 0.3% |
| request path: body parse and result encoding | 2.1% | 2.7 | isJsonContentType 0.8%, reformat 0.4%, get [native] 0.3%, readJsonBody 0.3% |
| request path: other (errors.ts) | 2.0% | 2.6 | randomBytes [native] 2.0%, decodeCallArgs 0.0%, newRequestId 0.0% |
| engine: caches and read sets | 1.7% | 2.1 | find 1.6%, get [native] 0.0%, set 0.0% |
| request path: other (deep-values.ts) | 0.9% | 1.2 | tooDeepToStringify 0.9% |
| engine: committer | 0.5% | 0.6 | changedBetween 0.5%, bumpRepeatable 0.0% |
| request path: other (openapi.ts) | 0.1% | 0.1 | openApiDocAt 0.1% |
| runtime (no JS caller) | 0.0% | 0.1 | (unknown) [native] 0.0%, then [native] 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0% |
| store read | 0.0% | 0.0 | close [native] 0.0% |
| request path: other (topology.ts) | 0.0% | 0.0 | (anonymous) 0.0%, measure 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| store write | 0.0% | 0.0 | run [native] 0.0% |
| request path: other (limit-warnings.ts) | 0.0% | 0.0 | functionWarnings 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.0 | writeValue 0.0% |
