## sqlite-cached

6808 req/s, p99 19.9 ms, errors 0.00%, server 1.08 cores (bun 0.96, thread 0.04, HeapHelper 0.03, JITWorker 0.03)

main thread busy 17.15 s of 22.28 s, 136236 requests, 125.9 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| request path: routing and server | 39.5% | 49.7 | fetch 12.1%, Response [native] 7.4%, requestIP [native] 4.9%, capped 2.2% |
| runtime (no JS caller) | 22.1% | 27.8 | (anonymous) [native] 22.0%, (unknown) [native] 0.1%, performPromiseThen [native] 0.0% |
| request path: function dispatch | 10.0% | 12.6 | loggedRun 1.2%, registryKey 0.8%, stringify [native] 0.8%, copyDataProperties [native] 0.8% |
| request path: function log | 6.4% | 8.0 | nextUp 1.5%, append 1.1%, withOwner 0.6%, DataView [native] 0.5% |
| engine: transactions | 5.8% | 7.3 | cachedQuery 1.2%, setTimeout [native] 1.1%, (anonymous) 0.6%, now [native] 0.5% |
| request path: metrics and tracing | 3.1% | 3.9 | add 1.2%, indexFor 0.6%, recordExecution 0.6%, execution 0.4% |
| request path: CORS | 3.0% | 3.8 | set [native] 1.0%, (anonymous) 0.7%, withCors 0.6%, hasApiCors 0.2% |
| request path: other (errors.ts) | 2.6% | 3.3 | randomBytes [native] 2.6%, newRequestId 0.0% |
| request path: body parse and result encoding | 2.3% | 2.9 | isJsonContentType 1.1%, get [native] 0.4%, reformat 0.3%, readJsonBody 0.3% |
| values | 2.1% | 2.7 | entries [native] 0.6%, identifierError 0.4%, fromJson 0.4%, toJson 0.4% |
| engine: caches and read sets | 1.5% | 1.9 | find 1.5%, derived 0.0% |
| request path: other (deep-values.ts) | 0.9% | 1.2 | tooDeepToStringify 0.9% |
| engine: committer | 0.4% | 0.5 | changedBetween 0.4% |
| request path: other (openapi.ts) | 0.1% | 0.2 | openApiDocAt 0.1% |
| request path: sync | 0.1% | 0.1 | (anonymous) 0.1% |
| store write | 0.0% | 0.1 | run [native] 0.0%, get inMemory 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |
| store read | 0.0% | 0.0 | close [native] 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.0 | stringify [native] 0.0% |

## sqlite-uncached

1739 req/s, p99 66.4 ms, errors 0.00%, server 1.14 cores (bun 0.94, JITWorker 0.08, HeapHelper 0.06, thread 0.04, JSCWarmUp 0.02)

main thread busy 18.88 s of 22.83 s, 34845 requests, 542.0 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| values | 39.1% | 211.9 | entries [native] 13.1%, byteLength [native] 6.3%, sizeOf 2.9%, toJson 2.8% |
| engine: transactions | 20.1% | 109.0 | parse [native] 4.1%, stringify [native] 3.2%, storeRangeOf 1.3%, fromEnv 0.8% |
| request path: routing and server | 11.2% | 60.8 | fetch 3.1%, Response [native] 2.4%, requestIP [native] 1.0%, (anonymous) 0.8% |
| runtime (no JS caller) | 6.0% | 32.4 | (anonymous) [native] 5.9%, (unknown) [native] 0.1%, onBufferedFastPathSettled [native] 0.0% |
| request path: function dispatch | 5.3% | 28.9 | (anonymous) 0.7%, stringify [native] 0.3%, loggedRun 0.2%, copyDataProperties [native] 0.2% |
| engine: caches and read sets | 4.0% | 21.5 | get buffer [native] 0.6%, read 0.6%, delete 0.6%, enforceLimit 0.3% |
| request path: body parse and result encoding | 2.5% | 13.8 | resultSnapshot 1.3%, reformat 0.6%, isJsonContentType 0.3%, snapshotOnSettle 0.1% |
| request path: metrics and tracing | 2.2% | 11.8 | add 0.7%, metric 0.6%, recordExecution 0.3%, indexFor 0.2% |
| engine: schema and shapes | 2.1% | 11.6 | fieldValue 1.1%, indexKeyValues 0.7%, pin 0.1%, (anonymous) 0.1% |
| request path: function log | 2.1% | 11.2 | append 0.3%, walk 0.2%, collectLogs 0.2%, withOwner 0.2% |
| store read | 2.0% | 11.0 | all [native] 1.8%, (anonymous) 0.1%, get buffer [native] 0.0%, latestLive 0.0% |
| request path: CORS | 1.1% | 5.8 | (anonymous) 0.4%, set [native] 0.2%, withCors 0.2%, hasApiCors 0.1% |
| request path: other (errors.ts) | 0.6% | 3.5 | randomBytes [native] 0.6%, decodeCallArgs 0.0% |
| request path: other (deep-values.ts) | 0.6% | 3.3 | tooDeepToStringify 0.6%, push [native] 0.0%, pop [native] 0.0%, set [native] 0.0% |
| request path: other (streaming-export.ts) | 0.4% | 2.0 | stringify [native] 0.2%, (anonymous) 0.1%, fieldsOf 0.1%, writeValue 0.0% |
| request path: other (action-permits.ts) | 0.3% | 1.9 | run 0.3%, shift [native] 0.1%, asyncFunctionDrive [native] 0.0% |
| request path: other (limit-warnings.ts) | 0.1% | 0.6 | functionWarnings 0.1%, approaching 0.0%, approachingDuration 0.0% |
| function | 0.1% | 0.5 | (anonymous) 0.1% |
| request path: other (storage.ts) | 0.0% | 0.1 | reader 0.0% |
| engine: committer | 0.0% | 0.1 | changedBetween 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.1 | openApiDocAt 0.0% |
| store write | 0.0% | 0.0 | run [native] 0.0% |
| request path: other (app-errors.ts) | 0.0% | 0.0 | appContext 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |

## sqlite-insert

1812 req/s, p99 71.8 ms, errors 0.00%, server 1.00 cores (bun 0.74, HeapHelper 0.10, JITWorker 0.09, JSCWarmUp 0.03, thread 0.03)

main thread busy 15.82 s of 22.30 s, 36259 requests, 436.4 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| store write | 32.9% | 143.7 | run [native] 31.2%, Buffer [native] 0.8%, internalIdBytes 0.4%, apply 0.1% |
| engine: transactions | 22.3% | 97.4 | (anonymous) 1.6%, Buffer [native] 1.5%, intervalSetsByIndex 1.5%, slice [native] 1.2% |
| request path: routing and server | 10.9% | 47.5 | fetch 3.4%, requestIP [native] 1.4%, Response [native] 0.8%, (anonymous) 0.8% |
| values | 8.2% | 36.0 | entries [native] 0.9%, sort [native] 0.8%, check 0.7%, isBytes 0.7% |
| request path: function dispatch | 5.7% | 24.9 | (anonymous) 0.6%, loggedRun 0.4%, invoke 0.4%, warned 0.3% |
| engine: schema and shapes | 4.8% | 21.0 | next [native] 0.4%, shapeOf 0.4%, maintainedIndexes 0.4%, mergeInto 0.4% |
| runtime (no JS caller) | 3.6% | 15.8 | (anonymous) [native] 3.6%, (unknown) [native] 0.0%, onBufferedFastPathSettled [native] 0.0% |
| request path: function log | 2.5% | 10.8 | (anonymous) 0.4%, withOwner 0.4%, collectLogs 0.3%, run 0.2% |
| request path: metrics and tracing | 1.9% | 8.3 | metric 0.7%, add 0.3%, recordExecution 0.3%, indexFor 0.1% |
| request path: body parse and result encoding | 1.8% | 8.0 | reformat 0.7%, isJsonContentType 0.3%, parse [native] 0.2%, readJsonBody 0.1% |
| engine: committer | 1.7% | 7.6 | drainGroups 0.4%, writeBatchOf 0.3%, (anonymous) [native] 0.1%, (anonymous) 0.1% |
| request path: CORS | 0.9% | 3.8 | (anonymous) 0.3%, set [native] 0.2%, hasApiCors 0.1%, pathOf 0.1% |
| request path: other (errors.ts) | 0.7% | 3.2 | randomBytes [native] 0.7%, decodeCallArgs 0.1% |
| request path: other (deep-values.ts) | 0.3% | 1.3 | tooDeepToStringify 0.3%, pop [native] 0.0% |
| request path: other (action-permits.ts) | 0.3% | 1.3 | run 0.3%, shift [native] 0.0% |
| function | 0.2% | 1.0 | (anonymous) 0.1%, performProxyObjectGet [native] 0.1% |
| request path: other (limit-warnings.ts) | 0.2% | 0.9 | functionWarnings 0.2%, approaching 0.0%, approachingDuration 0.0%, ratio 0.0% |
| engine: caches and read sets | 0.2% | 0.8 | derived 0.1%, (anonymous) 0.1%, constant 0.0%, matchingEntries 0.0% |
| request path: other (storage.ts) | 0.2% | 0.7 | writer 0.1%, cloneObject [native] 0.1%, reader 0.0% |
| request path: other (scheduler.ts) | 0.1% | 0.6 | (anonymous) 0.1%, makeScheduler 0.1%, some [native] 0.0%, poke 0.0% |
| request path: other (cron-executor.ts) | 0.1% | 0.4 | (anonymous) 0.1% |
| request path: other (openapi.ts) | 0.1% | 0.3 | openApiDocAt 0.1% |
| request path: other (executor-invalidations.ts) | 0.1% | 0.3 | observe 0.1% |
| store read | 0.1% | 0.3 | close [native] 0.1% |
| request path: sync | 0.1% | 0.3 | onCommit 0.1% |
| request path: other (function-handles.ts) | 0.0% | 0.1 | splitComponentFunctionName 0.0% |

## sqlite-increment1000

1101 req/s, p99 115.9 ms, errors 0.17%, server 1.14 cores (bun 0.82, JITWorker 0.16, HeapHelper 0.10, thread 0.03)

main thread busy 17.45 s of 22.30 s, 22043 requests, 791.5 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| store read | 24.8% | 196.4 | all [native] 20.5%, get [native] 2.5%, Buffer [native] 0.4%, internalIdBytes 0.2% |
| engine: transactions | 24.2% | 191.3 | intervalSetsByIndex 2.4%, Buffer [native] 2.1%, conflict 2.0%, (anonymous) 1.8% |
| store write | 17.0% | 134.3 | run [native] 16.1%, Buffer [native] 0.5%, internalIdBytes 0.2%, apply 0.1% |
| request path: routing and server | 7.8% | 62.1 | fetch 2.5%, requestIP [native] 0.8%, (anonymous) 0.6%, capped 0.5% |
| values | 7.3% | 57.8 | entries [native] 1.0%, isBytes 0.5%, identifierError 0.5%, sizeOf 0.5% |
| request path: function dispatch | 4.4% | 35.1 | (anonymous) 0.6%, loggedRun 0.4%, invoke 0.3%, copyDataProperties [native] 0.2% |
| engine: schema and shapes | 3.0% | 24.1 | maintainedIndexes 0.4%, fieldValue 0.3%, entries [native] 0.3%, isSubtype 0.2% |
| engine: caches and read sets | 2.3% | 18.6 | read 0.7%, get buffer [native] 0.5%, toString [native] 0.2%, fill 0.2% |
| runtime (no JS caller) | 2.1% | 16.7 | (anonymous) [native] 2.1%, (unknown) [native] 0.0%, performPromiseThen [native] 0.0% |
| request path: function log | 1.8% | 14.5 | withOwner 0.2%, collectLogs 0.2%, run 0.2%, (anonymous) 0.2% |
| request path: metrics and tracing | 1.2% | 9.7 | metric 0.5%, add 0.3%, recordExecution 0.2%, execution 0.0% |
| engine: committer | 1.2% | 9.5 | sourceAt 0.2%, drainGroups 0.1%, (anonymous) 0.1%, writeBatchOf 0.1% |
| request path: body parse and result encoding | 0.7% | 5.4 | isJsonContentType 0.3%, parse [native] 0.1%, snapshotOnSettle 0.1%, readJsonBody 0.1% |
| request path: CORS | 0.5% | 4.0 | (anonymous) 0.2%, hasApiCors 0.1%, withCors 0.1%, set [native] 0.1% |
| request path: other (errors.ts) | 0.4% | 3.4 | randomBytes [native] 0.4% |
| request path: other (deep-values.ts) | 0.2% | 1.7 | tooDeepToStringify 0.2%, set [native] 0.0%, get [native] 0.0% |
| request path: other (limit-warnings.ts) | 0.2% | 1.6 | functionWarnings 0.2%, approaching 0.0% |
| request path: other (action-permits.ts) | 0.2% | 1.4 | run 0.1%, shift [native] 0.0% |
| function | 0.2% | 1.4 | (anonymous) 0.2%, asyncFunctionDrive [native] 0.0% |
| request path: other (scheduler.ts) | 0.1% | 0.8 | makeScheduler 0.1%, some [native] 0.0%, (anonymous) 0.0% |
| request path: other (storage.ts) | 0.1% | 0.6 | writer 0.1%, reader 0.0% |
| request path: sync | 0.0% | 0.3 | (anonymous) 0.0%, onCommit 0.0% |
| request path: other (health.ts) | 0.0% | 0.2 | healthRoute 0.0% |
| request path: other (topology.ts) | 0.0% | 0.2 | counters 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.2 | openApiDocAt 0.0% |
| request path: other (cron-executor.ts) | 0.0% | 0.2 | (anonymous) 0.0%, some [native] 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.1 | observe 0.0% |

## postgres-cached

6258 req/s, p99 23.3 ms, errors 0.00%, server 1.07 cores (bun 0.94, HeapHelper 0.05, thread 0.04, JITWorker 0.02)

main thread busy 17.63 s of 22.68 s, 125236 requests, 140.8 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| request path: routing and server | 37.1% | 52.3 | fetch 11.3%, Response [native] 6.4%, requestIP [native] 4.3%, (anonymous) 2.2% |
| runtime (no JS caller) | 22.0% | 30.9 | (anonymous) [native] 20.1%, toString [native] 0.6%, Buffer [native] 0.5%, DataRow 0.2% |
| request path: function dispatch | 10.5% | 14.8 | loggedRun 1.2%, stringify [native] 0.8%, registryKey 0.8%, logCompletion 0.6% |
| request path: function log | 7.4% | 10.4 | nextUp 1.4%, append 1.1%, withOwner 0.9%, DataView [native] 0.8% |
| engine: transactions | 5.6% | 7.9 | setTimeout [native] 1.0%, cachedQuery 1.0%, (anonymous) 0.7%, clearTimeout [native] 0.5% |
| request path: metrics and tracing | 3.3% | 4.6 | add 1.5%, indexFor 0.6%, recordExecution 0.5%, execution 0.2% |
| request path: CORS | 3.0% | 4.2 | set [native] 0.9%, (anonymous) 0.8%, withCors 0.6%, get [native] 0.3% |
| request path: body parse and result encoding | 2.6% | 3.6 | isJsonContentType 1.2%, reformat 0.5%, readJsonBody 0.3%, get [native] 0.2% |
| request path: other (errors.ts) | 2.3% | 3.2 | randomBytes [native] 2.3%, decodeCallArgs 0.0% |
| values | 2.2% | 3.1 | entries [native] 0.7%, toJson 0.4%, fromJson 0.4%, identifierError 0.4% |
| engine: caches and read sets | 1.6% | 2.3 | find 1.6%, set [native] 0.0% |
| store write | 1.2% | 1.7 | get buffer [native] 0.5%, toString [native] 0.3%, (anonymous) 0.2%, BigInt [native] 0.1% |
| request path: other (deep-values.ts) | 1.0% | 1.3 | tooDeepToStringify 0.9%, pop [native] 0.0% |
| request path: other (openapi.ts) | 0.1% | 0.2 | openApiDocAt 0.1% |
| engine: committer | 0.1% | 0.1 | changedBetween 0.1% |
| request path: other (health.ts) | 0.1% | 0.1 | healthRoute 0.1% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0% |
| request path: other (topology.ts) | 0.0% | 0.0 | measure 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| store read | 0.0% | 0.0 | get 0.0% |
| engine: schema and shapes | 0.0% | 0.0 | indexKeyValues 0.0% |

## postgres-uncached

1401 req/s, p99 95.9 ms, errors 0.00%, server 1.18 cores (bun 0.92, JITWorker 0.13, HeapHelper 0.07, thread 0.04)

main thread busy 18.20 s of 22.43 s, 28082 requests, 648.1 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| values | 33.0% | 213.8 | entries [native] 11.2%, byteLength [native] 5.0%, isBytes 2.4%, valueHasLoneSurrogate 2.4% |
| engine: transactions | 18.5% | 120.1 | parse [native] 3.7%, stringify [native] 2.6%, storeRangeOf 1.3%, (anonymous) 0.9% |
| runtime (no JS caller) | 17.1% | 110.8 | (anonymous) [native] 8.2%, toString [native] 2.0%, Buffer [native] 1.8%, writeBuffered [native] 1.5% |
| request path: routing and server | 8.0% | 52.1 | fetch 1.9%, Response [native] 1.8%, requestIP [native] 0.8%, (anonymous) 0.7% |
| request path: function dispatch | 4.3% | 28.0 | (anonymous) 0.6%, loggedRun 0.3%, stringify [native] 0.3%, warned 0.2% |
| store read | 3.3% | 21.6 | get buffer [native] 0.8%, toString [native] 0.6%, Buffer [native] 0.4%, (anonymous) 0.3% |
| engine: caches and read sets | 3.2% | 20.6 | get buffer [native] 0.6%, delete 0.4%, read 0.4%, find 0.3% |
| request path: body parse and result encoding | 2.3% | 14.9 | resultSnapshot 1.2%, reformat 0.5%, isJsonContentType 0.1%, parse [native] 0.1% |
| request path: metrics and tracing | 2.2% | 14.1 | metric 0.6%, add 0.5%, recordExecution 0.3%, (anonymous) 0.2% |
| engine: schema and shapes | 2.0% | 12.7 | fieldValue 1.0%, indexKeyValues 0.6%, map [native] 0.2%, (anonymous) 0.1% |
| request path: function log | 1.9% | 12.4 | append 0.2%, withOwner 0.2%, nextUp 0.2%, collectLogs 0.2% |
| store write | 0.9% | 5.8 | get buffer [native] 0.4%, toString [native] 0.2%, BigInt [native] 0.1%, Buffer [native] 0.1% |
| request path: CORS | 0.8% | 5.0 | (anonymous) 0.3%, set [native] 0.2%, withCors 0.1%, get [native] 0.1% |
| request path: other (action-permits.ts) | 0.6% | 4.1 | run 0.4%, (anonymous) 0.1%, set 0.1%, copyUntil 0.0% |
| request path: other (streaming-export.ts) | 0.5% | 3.2 | stringify [native] 0.2%, fieldsOf 0.1%, writeValue 0.1%, filter [native] 0.1% |
| request path: other (deep-values.ts) | 0.5% | 3.1 | tooDeepToStringify 0.5%, pop [native] 0.0%, set [native] 0.0% |
| request path: other (errors.ts) | 0.3% | 2.2 | randomBytes [native] 0.3% |
| function | 0.2% | 1.3 | (anonymous) 0.2% |
| request path: other (limit-warnings.ts) | 0.1% | 0.8 | functionWarnings 0.1%, approaching 0.0% |
| request path: other (openapi.ts) | 0.1% | 0.4 | openApiDocAt 0.1% |
| request path: other (health.ts) | 0.1% | 0.4 | healthRoute 0.1% |
| engine: committer | 0.0% | 0.2 | changedBetween 0.0% |
| request path: sync | 0.0% | 0.1 | (anonymous) 0.0% |
| request path: other (storage.ts) | 0.0% | 0.1 | reader 0.0% |
| request path: other (topology.ts) | 0.0% | 0.0 | sample 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| request path: other (session-cleanup.ts) | 0.0% | 0.0 | (anonymous) 0.0% |

## postgres-insert

1994 req/s, p99 60.9 ms, errors 0.00%, server 1.02 cores (bun 0.71, JITWorker 0.14, HeapHelper 0.09, thread 0.03, JSCWarmUp 0.02)

main thread busy 14.27 s of 22.65 s, 39909 requests, 357.5 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| engine: transactions | 27.6% | 98.7 | (anonymous) 2.4%, Buffer [native] 2.1%, intervalSetsByIndex 1.7%, slice [native] 1.1% |
| request path: routing and server | 13.7% | 49.0 | fetch 4.4%, requestIP [native] 1.6%, (anonymous) 1.1%, capped 0.9% |
| runtime (no JS caller) | 13.4% | 48.0 | (anonymous) [native] 6.6%, writeBuffered [native] 2.6%, defineProperties [native] 0.4%, subarray [native] 0.3% |
| values | 10.3% | 36.9 | entries [native] 1.4%, sort [native] 1.1%, check 0.8%, toJson 0.7% |
| request path: function dispatch | 7.0% | 24.9 | (anonymous) 1.0%, invoke 0.6%, loggedRun 0.5%, warned 0.4% |
| engine: schema and shapes | 6.2% | 22.0 | maintainedIndexes 0.7%, next [native] 0.4%, mergeInto 0.4%, isSubtype 0.4% |
| store read | 4.1% | 14.7 | stringify [native] 3.8%, (anonymous) 0.1%, replace [native] 0.1%, unsafe 0.0% |
| store write | 3.6% | 13.0 | hash [native] 0.9%, internalIdHex 0.7%, cachedIdHex 0.7%, bytesToHex 0.4% |
| request path: function log | 3.3% | 11.9 | (anonymous) 0.7%, withOwner 0.5%, collectLogs 0.3%, run 0.2% |
| request path: metrics and tracing | 2.4% | 8.5 | metric 0.7%, add 0.5%, recordExecution 0.4%, recordOutstanding 0.1% |
| request path: body parse and result encoding | 2.1% | 7.6 | reformat 0.9%, isJsonContentType 0.5%, parse [native] 0.2%, get [native] 0.1% |
| engine: committer | 2.0% | 7.0 | writeBatchOf 0.4%, drainGroups 0.3%, (anonymous) 0.3%, sort [native] 0.1% |
| request path: CORS | 1.2% | 4.2 | (anonymous) 0.4%, set [native] 0.2%, withCors 0.1%, hasApiCors 0.1% |
| request path: other (errors.ts) | 0.9% | 3.2 | randomBytes [native] 0.8%, decodeCallArgs 0.1% |
| request path: other (action-permits.ts) | 0.4% | 1.5 | run 0.4%, shift [native] 0.1% |
| request path: other (deep-values.ts) | 0.3% | 1.2 | tooDeepToStringify 0.3%, push [native] 0.0% |
| request path: other (storage.ts) | 0.3% | 1.0 | writer 0.2%, cloneObject [native] 0.1%, reader 0.0% |
| engine: caches and read sets | 0.3% | 1.0 | constant 0.1%, derived 0.1%, (anonymous) 0.0%, matching 0.0% |
| function | 0.2% | 0.8 | (anonymous) 0.2%, performProxyObjectGet [native] 0.0%, reallyExit [native] 0.0% |
| request path: other (limit-warnings.ts) | 0.2% | 0.7 | functionWarnings 0.2%, ratio 0.0%, approachingDuration 0.0% |
| request path: other (scheduler.ts) | 0.2% | 0.7 | (anonymous) 0.1%, makeScheduler 0.1%, some [native] 0.0% |
| request path: other (openapi.ts) | 0.1% | 0.2 | openApiDocAt 0.1% |
| request path: other (executor-invalidations.ts) | 0.1% | 0.2 | observe 0.1% |
| request path: sync | 0.0% | 0.2 | onCommit 0.0% |
| request path: other (cron-executor.ts) | 0.0% | 0.2 | (anonymous) 0.0%, some [native] 0.0% |
| request path: other (health.ts) | 0.0% | 0.1 | healthRoute 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.1 | writeValue 0.0% |

## postgres-increment1000

871 req/s, p99 385.1 ms, errors 0.36%, server 1.19 cores (bun 0.85, JITWorker 0.21, HeapHelper 0.07, thread 0.04)

main thread busy 16.85 s of 23.07 s, 17895 requests, 941.4 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| engine: transactions | 31.0% | 291.8 | conflict 4.2%, Buffer [native] 2.5%, intervalSetsByIndex 1.9%, (anonymous) 1.4% |
| runtime (no JS caller) | 26.6% | 250.6 | writeBuffered [native] 6.1%, (anonymous) [native] 5.4%, subarray [native] 1.4%, toString [native] 1.0% |
| values | 8.5% | 80.1 | entries [native] 1.2%, sizeOf 0.7%, byteLength [native] 0.5%, isBytes 0.5% |
| store read | 7.5% | 71.0 | stringify [native] 1.5%, Buffer [native] 1.0%, then [native] 0.7%, (anonymous) 0.6% |
| request path: routing and server | 6.4% | 59.8 | fetch 2.0%, requestIP [native] 0.8%, Response [native] 0.5%, (anonymous) 0.4% |
| request path: function dispatch | 4.0% | 37.4 | (anonymous) 0.5%, invoke 0.3%, loggedRun 0.3%, withAudit 0.2% |
| engine: schema and shapes | 3.5% | 32.7 | fieldValue 0.4%, maintainedIndexes 0.4%, next [native] 0.3%, map [native] 0.3% |
| engine: caches and read sets | 2.8% | 26.4 | read 1.0%, get buffer [native] 0.5%, fill 0.3%, toString [native] 0.2% |
| engine: committer | 1.9% | 18.3 | sourceAt 0.4%, drainGroups 0.2%, writeBatchOf 0.2%, changedBetween 0.1% |
| request path: function log | 1.6% | 14.7 | (anonymous) 0.2%, withOwner 0.2%, collectLogs 0.1%, walk 0.1% |
| request path: metrics and tracing | 1.5% | 14.6 | metric 0.6%, add 0.4%, recordExecution 0.2%, recordOutstanding 0.1% |
| store write | 1.5% | 14.5 | internalIdHex 0.3%, hash [native] 0.3%, bytesToHex 0.2%, keyColumns 0.2% |
| request path: body parse and result encoding | 0.6% | 5.9 | isJsonContentType 0.2%, reformat 0.1%, readJsonBody 0.1%, resultSnapshot 0.1% |
| request path: other (action-permits.ts) | 0.6% | 5.2 | run 0.3%, (anonymous) 0.1%, (anonymous) [native] 0.1%, set 0.0% |
| request path: CORS | 0.6% | 5.2 | (anonymous) 0.2%, withCors 0.1%, set [native] 0.1%, get [native] 0.1% |
| request path: other (errors.ts) | 0.3% | 3.1 | randomBytes [native] 0.3%, decodeCallArgs 0.0% |
| function | 0.2% | 2.1 | (anonymous) 0.2% |
| request path: other (deep-values.ts) | 0.2% | 1.9 | tooDeepToStringify 0.2%, isArray [native] 0.0%, pop [native] 0.0% |
| request path: other (limit-warnings.ts) | 0.2% | 1.5 | functionWarnings 0.1%, ratio 0.0%, approaching 0.0%, approachingDuration 0.0% |
| request path: other (scheduler.ts) | 0.1% | 1.1 | (anonymous) 0.1%, makeScheduler 0.1%, some [native] 0.0% |
| request path: other (storage.ts) | 0.1% | 1.0 | writer 0.1%, reader 0.0%, cloneObject [native] 0.0% |
| request path: other (openapi.ts) | 0.1% | 0.6 | openApiDocAt 0.1% |
| request path: other (executor-invalidations.ts) | 0.1% | 0.5 | observe 0.0%, get [native] 0.0% |
| request path: other (health.ts) | 0.1% | 0.5 | healthRoute 0.1% |
| request path: other (cron-executor.ts) | 0.0% | 0.3 | some [native] 0.0%, (anonymous) 0.0%, poke 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.2 | splitComponentFunctionName 0.0% |
| request path: sync | 0.0% | 0.2 | onCommit 0.0%, (anonymous) 0.0% |
