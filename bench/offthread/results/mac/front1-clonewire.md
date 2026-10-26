## sqlite-cached

33873 req/s, p99 2.3 ms, errors 0.00%, server 1.82 cores

main thread busy 7.40 s of 12.34 s, 338762 requests, 21.8 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| request path: routing and server | 33.1% | 7.2 | fetch 12.4%, Response [native] 7.3%, capped 2.5%, text [native] 2.0% |
| prototype: thread messages | 27.0% | 5.9 | postMessage [native] 21.6%, Request [native] 1.9%, next [native] 1.7%, text [native] 0.6% |
| request path: function dispatch | 9.8% | 2.1 | registryKey 1.3%, loggedRun 0.8%, metricsNameOf 0.8%, copyDataProperties [native] 0.7% |
| request path: function log | 7.5% | 1.6 | append 2.0%, nextUp 1.3%, withOwner 0.8%, DataView [native] 0.5% |
| engine: transactions | 6.3% | 1.4 | cachedQuery 1.3%, setTimeout [native] 1.0%, (anonymous) 0.9%, now [native] 0.9% |
| request path: metrics and tracing | 3.7% | 0.8 | add 1.3%, recordExecution 0.7%, indexFor 0.7%, (anonymous) 0.3% |
| request path: CORS | 3.4% | 0.7 | set [native] 1.3%, withCors 0.8%, (anonymous) 0.7%, get [native] 0.2% |
| request path: body parse and result encoding | 2.4% | 0.5 | isJsonContentType 0.9%, reformat 0.6%, readJsonBody 0.3%, get [native] 0.2% |
| values | 1.8% | 0.4 | entries [native] 0.7%, fromJson 0.4%, isBytes 0.3%, toJson 0.2% |
| request path: other (deep-values.ts) | 1.6% | 0.3 | tooDeepToStringify 1.6% |
| request path: other (errors.ts) | 1.3% | 0.3 | randomBytes [native] 1.3% |
| engine: caches and read sets | 1.2% | 0.3 | find 1.2% |
| engine: committer | 0.4% | 0.1 | changedBetween 0.4% |
| store read | 0.2% | 0.0 | close [native] 0.2%, all [native] 0.0% |
| request path: other (openapi.ts) | 0.2% | 0.0 | openApiDocAt 0.2% |
| request path: other (function-handles.ts) | 0.1% | 0.0 | splitComponentFunctionName 0.1% |
| request path: other (health.ts) | 0.1% | 0.0 | healthRoute 0.1% |
| request path: other (topology.ts) | 0.0% | 0.0 | measure 0.0%, stop 0.0% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0% |
