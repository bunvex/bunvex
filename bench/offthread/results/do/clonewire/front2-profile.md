## sqlite-cached

5961 req/s, p99 195.7 ms, errors 0.00%, server 1.67 cores (bun 0.95, Worker 0.55, HeapHelper 0.06, thread 0.04, JITWorker 0.03, mi-scavenger 0.03)

main thread busy 17.55 s of 22.32 s, 119262 requests, 147.1 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| request path: routing and server | 32.5% | 47.9 | fetch 11.2%, Response [native] 5.9%, capped 2.4%, (anonymous) 1.9% |
| prototype: thread messages | 27.8% | 40.9 | postMessage [native] 21.5%, Request [native] 2.0%, next [native] 1.8%, (anonymous) 0.9% |
| request path: function dispatch | 10.5% | 15.4 | loggedRun 1.1%, stringify [native] 0.9%, registryKey 0.8%, copyDataProperties [native] 0.7% |
| request path: function log | 6.5% | 9.6 | nextUp 1.4%, append 0.9%, withOwner 0.8%, collectLogs 0.6% |
| engine: transactions | 5.9% | 8.6 | cachedQuery 1.2%, setTimeout [native] 1.0%, stillValid 0.6%, (anonymous) 0.6% |
| request path: metrics and tracing | 3.6% | 5.3 | add 1.7%, recordExecution 0.6%, execution 0.4%, indexFor 0.4% |
| request path: CORS | 3.4% | 5.0 | set [native] 1.2%, (anonymous) 0.9%, withCors 0.6%, get [native] 0.2% |
| request path: body parse and result encoding | 2.3% | 3.4 | isJsonContentType 1.0%, readJsonBody 0.3%, reformat 0.3%, get [native] 0.2% |
| values | 2.2% | 3.3 | entries [native] 0.5%, toJson 0.5%, identifierError 0.4%, fromJson 0.4% |
| request path: other (errors.ts) | 2.0% | 3.0 | randomBytes [native] 2.0%, newRequestId 0.0% |
| engine: caches and read sets | 1.6% | 2.4 | find 1.6%, get [native] 0.0%, delete [native] 0.0% |
| request path: other (deep-values.ts) | 0.9% | 1.4 | tooDeepToStringify 0.9%, get [native] 0.0% |
| engine: committer | 0.3% | 0.5 | changedBetween 0.3%, bumpRepeatable 0.0% |
| request path: other (openapi.ts) | 0.1% | 0.2 | openApiDocAt 0.1% |
| store write | 0.0% | 0.0 | run [native] 0.0% |
| store read | 0.0% | 0.0 | close [native] 0.0%, all [native] 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |
| runtime (no JS caller) | 0.0% | 0.0 | (unknown) [native] 0.0%, then [native] 0.0% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0% |
| request path: other (storage.ts) | 0.0% | 0.0 | reader 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.0 | stringify [native] 0.0% |
| request path: other (topology.ts) | 0.0% | 0.0 | (anonymous) 0.0% |
