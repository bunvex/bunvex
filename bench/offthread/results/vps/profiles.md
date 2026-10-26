## sqlite-cached

7588 req/s, p99 14.4 ms, errors 0.00%, server 0.89 cores (bun 0.82, JITWorker 0.03, thread 0.03)

main thread busy 15.25 s of 22.01 s, 151770 requests, 100.5 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| request path: routing and server | 38.3% | 38.5 | fetch 10.6%, Response [native] 6.7%, requestIP [native] 3.5%, requestVerdict 3.0% |
| runtime (no JS caller) | 24.5% | 24.6 | (anonymous) [native] 24.3%, performPromiseThen [native] 0.1%, onBufferedFastPathSettled [native] 0.1%, (unknown) [native] 0.0% |
| request path: function dispatch | 11.2% | 11.2 | components 1.2%, loggedRun 0.8%, registryKey 0.8%, stringify [native] 0.7% |
| request path: function log | 5.6% | 5.7 | nextUp 1.1%, append 0.7%, DataView [native] 0.6%, withOwner 0.6% |
| engine: transactions | 4.7% | 4.8 | cachedQuery 1.0%, setTimeout [native] 1.0%, stillValid 0.4%, (anonymous) 0.4% |
| request path: body parse and result encoding | 3.8% | 3.9 | parse [native] 1.4%, isJsonContentType 1.3%, readJsonBody 0.4%, reformat 0.3% |
| request path: CORS | 3.0% | 3.0 | (anonymous) 1.0%, set [native] 0.7%, withCors 0.6%, hasApiCors 0.3% |
| request path: metrics and tracing | 2.4% | 2.4 | add 1.0%, recordExecution 0.4%, indexFor 0.3%, execution 0.3% |
| values | 2.0% | 2.1 | entries [native] 0.6%, identifierError 0.6%, toJson 0.4%, fromJson 0.3% |
| request path: other (errors.ts) | 1.5% | 1.5 | randomBytes [native] 1.5%, newRequestId 0.0% |
| engine: caches and read sets | 1.3% | 1.3 | find 1.3%, get [native] 0.0% |
| request path: other (deep-values.ts) | 0.9% | 0.9 | tooDeepToStringify 0.9%, pop [native] 0.0%, get [native] 0.0% |
| engine: committer | 0.4% | 0.4 | changedBetween 0.4% |
| request path: other (openapi.ts) | 0.1% | 0.1 | openApiDocAt 0.1% |
| request path: other (health.ts) | 0.1% | 0.1 | healthRoute 0.1% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | inHandleScope 0.0%, splitComponentFunctionName 0.0% |
| function | 0.0% | 0.0 | (anonymous) 0.0% |
| request path: other (limit-warnings.ts) | 0.0% | 0.0 | approachingDuration 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.0 | writeValue 0.0% |
| store write | 0.0% | 0.0 | run [native] 0.0% |
| engine: schema and shapes | 0.0% | 0.0 | stop 0.0% |
| store read | 0.0% | 0.0 | close [native] 0.0% |

## sqlite-uncached

1564 req/s, p99 81.6 ms, errors 0.00%, server 0.97 cores (bun 0.82, JITWorker 0.09, thread 0.03)

main thread busy 17.07 s of 22.07 s, 31300 requests, 545.3 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| values | 28.2% | 153.7 | entries [native] 8.9%, byteLength [native] 3.3%, toJson 2.5%, valueHasLoneSurrogate 2.5% |
| engine: transactions | 21.5% | 117.1 | parse [native] 5.5%, stringify [native] 2.6%, storeRangeOf 1.5%, (anonymous) 1.2% |
| request path: routing and server | 12.9% | 70.5 | Response [native] 3.0%, fetch 3.0%, requestIP [native] 1.0%, (anonymous) 0.9% |
| runtime (no JS caller) | 9.7% | 53.1 | (anonymous) [native] 9.6%, (unknown) [native] 0.1%, onBufferedFastPathSettled [native] 0.0%, performPromiseThen [native] 0.0% |
| request path: function dispatch | 5.6% | 30.6 | (anonymous) 0.8%, components 0.4%, stringify [native] 0.2%, loggedRun 0.2% |
| store read | 3.9% | 21.2 | all [native] 3.5%, get buffer [native] 0.1%, (anonymous) 0.1%, toString [native] 0.1% |
| engine: caches and read sets | 3.9% | 21.2 | read 0.8%, get buffer [native] 0.6%, find 0.5%, delete 0.4% |
| request path: body parse and result encoding | 3.7% | 20.0 | resultSnapshot 1.1%, parse [native] 0.8%, reformat 0.7%, isJsonContentType 0.4% |
| request path: function log | 2.7% | 14.6 | append 0.3%, run 0.3%, withOwner 0.2%, collectLogs 0.2% |
| engine: schema and shapes | 2.2% | 11.9 | fieldValue 1.0%, indexKeyValues 0.8%, pin 0.2%, map [native] 0.1% |
| request path: metrics and tracing | 2.1% | 11.4 | add 0.6%, metric 0.5%, recordExecution 0.3%, indexFor 0.2% |
| request path: CORS | 1.0% | 5.5 | (anonymous) 0.4%, set [native] 0.2%, withCors 0.2%, get [native] 0.1% |
| request path: other (streaming-export.ts) | 0.7% | 3.7 | stringify [native] 0.3%, filter [native] 0.1%, fieldsOf 0.1%, writeValue 0.1% |
| request path: other (deep-values.ts) | 0.7% | 3.5 | tooDeepToStringify 0.6%, pop [native] 0.0%, push [native] 0.0%, set [native] 0.0% |
| request path: other (errors.ts) | 0.5% | 2.5 | randomBytes [native] 0.4%, decodeCallArgs 0.0% |
| request path: other (action-permits.ts) | 0.3% | 1.9 | run 0.3%, shift [native] 0.1%, asyncFunctionDrive [native] 0.0% |
| request path: other (limit-warnings.ts) | 0.2% | 0.9 | functionWarnings 0.1%, approaching 0.0%, approachingDuration 0.0% |
| function | 0.1% | 0.6 | (anonymous) 0.1%, asyncFunctionDrive [native] 0.0% |
| request path: other (health.ts) | 0.1% | 0.4 | healthRoute 0.1% |
| engine: committer | 0.0% | 0.3 | changedBetween 0.0%, bumpRepeatable 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.3 | openApiDocAt 0.0% |
| request path: sync | 0.0% | 0.2 | (anonymous) 0.0% |
| store write | 0.0% | 0.2 | run [native] 0.0% |
| request path: other (storage.ts) | 0.0% | 0.1 | reader 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.1 | splitComponentFunctionName 0.0% |

## sqlite-insert

1418 req/s, p99 67.9 ms, errors 0.00%, server 0.77 cores (bun 0.63, JITWorker 0.09, thread 0.02)

main thread busy 14.61 s of 22.43 s, 28387 requests, 514.8 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| store write | 38.1% | 195.9 | run [native] 35.9%, Buffer [native] 0.9%, internalIdBytes 0.6%, #run 0.4% |
| engine: transactions | 18.9% | 97.2 | (anonymous) 1.4%, Buffer [native] 1.4%, intervalSetsByIndex 1.0%, slice [native] 1.0% |
| request path: routing and server | 10.2% | 52.7 | fetch 2.7%, (anonymous) 1.0%, requestIP [native] 1.0%, requestVerdict 0.8% |
| values | 7.1% | 36.7 | check 0.9%, entries [native] 0.8%, sort [native] 0.6%, toJson 0.5% |
| request path: function dispatch | 6.6% | 33.8 | (anonymous) 1.0%, invoke 0.6%, components 0.5%, loggedRun 0.4% |
| engine: schema and shapes | 5.2% | 27.0 | shapeOf 0.7%, mergeInto 0.5%, isSubtype 0.4%, filter [native] 0.3% |
| runtime (no JS caller) | 3.7% | 18.9 | (anonymous) [native] 3.6%, performPromiseThen [native] 0.0%, onBufferedFastPathSettled [native] 0.0% |
| request path: function log | 2.4% | 12.5 | withOwner 0.4%, (anonymous) 0.3%, collectLogs 0.3%, filter [native] 0.2% |
| request path: body parse and result encoding | 2.0% | 10.5 | parse [native] 0.6%, reformat 0.4%, isJsonContentType 0.3%, readJsonBody 0.2% |
| request path: metrics and tracing | 1.3% | 6.9 | metric 0.3%, add 0.2%, addGaugeMax 0.2%, recordExecution 0.1% |
| engine: committer | 1.2% | 6.4 | drainGroups 0.3%, (anonymous) 0.2%, writeBatchOf 0.1%, commitWriteBytes 0.1% |
| request path: CORS | 0.6% | 2.8 | (anonymous) 0.3%, hasApiCors 0.1%, withCors 0.1%, pathOf 0.0% |
| request path: other (errors.ts) | 0.5% | 2.7 | randomBytes [native] 0.5% |
| request path: other (storage.ts) | 0.4% | 1.9 | reader 0.2%, writer 0.1%, cloneObject [native] 0.1% |
| request path: other (action-permits.ts) | 0.4% | 1.8 | run 0.3%, shift [native] 0.0%, asyncFunctionDrive [native] 0.0% |
| request path: other (scheduler.ts) | 0.3% | 1.6 | makeScheduler 0.2%, (anonymous) 0.0%, some [native] 0.0%, asyncFunctionDrive [native] 0.0% |
| request path: other (deep-values.ts) | 0.3% | 1.6 | tooDeepToStringify 0.3% |
| request path: other (limit-warnings.ts) | 0.2% | 1.1 | functionWarnings 0.2%, approaching 0.0%, approachingDuration 0.0% |
| engine: caches and read sets | 0.2% | 1.1 | derived 0.1%, (anonymous) 0.1%, constant 0.0% |
| function | 0.1% | 0.7 | (anonymous) 0.1%, performProxyObjectGet [native] 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.2 | observe 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.2 | writeValue 0.0% |
| store read | 0.0% | 0.2 | close [native] 0.0% |
| request path: other (health.ts) | 0.0% | 0.1 | healthRoute 0.0% |
| request path: other (topology.ts) | 0.0% | 0.1 | sample 0.0%, cpuUsage [native] 0.0% |
| request path: other (cron-executor.ts) | 0.0% | 0.1 | (anonymous) 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |

## sqlite-increment1000

869 req/s, p99 115.4 ms, errors 0.01%, server 0.84 cores (bun 0.66, JITWorker 0.12, thread 0.03)

main thread busy 15.34 s of 22.06 s, 17424 requests, 880.5 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| engine: transactions | 26.0% | 228.8 | Buffer [native] 2.2%, intervalSetsByIndex 1.9%, (anonymous) 1.7%, conflict 1.5% |
| store write | 20.1% | 177.4 | run [native] 19.0%, Buffer [native] 0.6%, internalIdBytes 0.2%, #run 0.2% |
| store read | 17.6% | 155.0 | all [native] 14.1%, get [native] 1.6%, Buffer [native] 0.4%, latestLive 0.3% |
| values | 7.5% | 66.1 | entries [native] 1.0%, encode [native] 0.6%, (anonymous) 0.5%, check 0.5% |
| request path: routing and server | 6.7% | 59.3 | fetch 1.9%, (anonymous) 0.7%, requestIP [native] 0.7%, requestVerdict 0.5% |
| request path: function dispatch | 5.0% | 43.8 | (anonymous) 0.6%, invoke 0.4%, components 0.3%, loggedRun 0.3% |
| engine: schema and shapes | 3.8% | 33.3 | indexKeyValues 0.3%, shapeOf 0.3%, map [native] 0.3%, maintainedIndexes 0.3% |
| engine: caches and read sets | 2.9% | 25.2 | read 0.8%, get buffer [native] 0.4%, fill 0.3%, toString [native] 0.2% |
| runtime (no JS caller) | 2.2% | 19.5 | (anonymous) [native] 2.2%, performPromiseThen [native] 0.0%, (unknown) [native] 0.0% |
| request path: function log | 1.7% | 15.1 | (anonymous) 0.2%, collectLogs 0.2%, withOwner 0.2%, newExecution 0.1% |
| engine: committer | 1.5% | 13.1 | drainGroups 0.2%, (anonymous) 0.2%, sourceAt 0.2%, sort [native] 0.1% |
| request path: body parse and result encoding | 1.3% | 11.5 | parse [native] 0.4%, isJsonContentType 0.2%, readJsonBody 0.2%, snapshotOnSettle 0.1% |
| request path: metrics and tracing | 1.2% | 10.5 | metric 0.4%, add 0.2%, recordExecution 0.2%, addGaugeMax 0.1% |
| request path: CORS | 0.6% | 4.8 | (anonymous) 0.2%, withCors 0.1%, slice [native] 0.1%, hasApiCors 0.1% |
| request path: other (errors.ts) | 0.4% | 3.9 | randomBytes [native] 0.4%, newRequestId 0.0% |
| function | 0.3% | 2.9 | (anonymous) 0.3% |
| request path: other (action-permits.ts) | 0.2% | 2.2 | run 0.2%, shift [native] 0.1%, asyncFunctionDrive [native] 0.0% |
| request path: other (storage.ts) | 0.2% | 1.8 | writer 0.1%, reader 0.1%, cloneObject [native] 0.0% |
| request path: other (deep-values.ts) | 0.2% | 1.8 | tooDeepToStringify 0.2%, pop [native] 0.0%, get [native] 0.0% |
| request path: other (scheduler.ts) | 0.2% | 1.6 | makeScheduler 0.2%, (anonymous) 0.0%, stop 0.0%, abort [native] 0.0% |
| request path: other (limit-warnings.ts) | 0.2% | 1.6 | functionWarnings 0.1%, approaching 0.0%, ratio 0.0% |
| request path: other (health.ts) | 0.0% | 0.4 | healthRoute 0.0% |
| request path: other (cron-executor.ts) | 0.0% | 0.3 | (anonymous) 0.0%, some [native] 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.2 | openApiDocAt 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.2 | startsWith [native] 0.0%, splitComponentFunctionName 0.0% |
| request path: sync | 0.0% | 0.1 | onCommit 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.1 | observe 0.0% |

## postgres-cached

7723 req/s, p99 14.1 ms, errors 0.00%, server 0.89 cores (bun 0.81, JITWorker 0.03, thread 0.03)

main thread busy 15.00 s of 22.41 s, 154468 requests, 97.1 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| request path: routing and server | 38.3% | 37.2 | fetch 10.2%, Response [native] 7.2%, requestIP [native] 3.6%, requestVerdict 3.1% |
| runtime (no JS caller) | 25.0% | 24.3 | (anonymous) [native] 24.7%, performPromiseThen [native] 0.1%, onBufferedFastPathSettled [native] 0.1%, writeBuffered [native] 0.0% |
| request path: function dispatch | 11.5% | 11.2 | registryKey 0.9%, copyDataProperties [native] 0.8%, forEach [native] 0.8%, loggedRun 0.7% |
| request path: function log | 5.6% | 5.4 | nextUp 1.1%, append 0.7%, DataView [native] 0.6%, withOwner 0.5% |
| engine: transactions | 4.5% | 4.4 | cachedQuery 1.0%, setTimeout [native] 0.8%, (anonymous) 0.4%, clearTimeout [native] 0.4% |
| request path: body parse and result encoding | 3.6% | 3.5 | parse [native] 1.2%, isJsonContentType 1.0%, readJsonBody 0.4%, reformat 0.3% |
| request path: CORS | 2.8% | 2.7 | (anonymous) 1.0%, set [native] 0.6%, withCors 0.6%, hasApiCors 0.2% |
| request path: metrics and tracing | 2.4% | 2.4 | add 0.8%, recordExecution 0.4%, indexFor 0.4%, execution 0.3% |
| values | 2.4% | 2.3 | identifierError 0.7%, entries [native] 0.6%, toJson 0.4%, fromJson 0.4% |
| request path: other (errors.ts) | 1.6% | 1.5 | randomBytes [native] 1.6%, newRequestId 0.0%, decodeCallArgs 0.0% |
| engine: caches and read sets | 1.2% | 1.2 | find 1.2%, readySize 0.0%, read 0.0% |
| request path: other (deep-values.ts) | 0.7% | 0.6 | tooDeepToStringify 0.7% |
| request path: other (openapi.ts) | 0.2% | 0.2 | openApiDocAt 0.2% |
| engine: committer | 0.1% | 0.1 | changedBetween 0.1% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |
| function | 0.0% | 0.0 | (anonymous) 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.0 | isNaN [native] 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| request path: other (topology.ts) | 0.0% | 0.0 | cpuUsage [native] 0.0% |
| store read | 0.0% | 0.0 | close 0.0% |

## postgres-uncached

964 req/s, p99 142.8 ms, errors 0.00%, server 0.81 cores (bun 0.66, JITWorker 0.10, thread 0.02)

main thread busy 15.03 s of 22.21 s, 19299 requests, 778.6 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| runtime (no JS caller) | 26.5% | 206.0 | (anonymous) [native] 8.8%, writeBuffered [native] 6.5%, toString [native] 2.3%, Buffer [native] 1.9% |
| values | 22.7% | 176.4 | entries [native] 7.7%, byteLength [native] 2.4%, toJson 2.0%, valueHasLoneSurrogate 2.0% |
| engine: transactions | 16.3% | 126.7 | parse [native] 3.0%, stringify [native] 2.0%, storeRangeOf 1.3%, (anonymous) 0.9% |
| request path: routing and server | 9.8% | 76.5 | fetch 2.5%, Response [native] 2.0%, (anonymous) 0.9%, requestIP [native] 0.8% |
| request path: function dispatch | 5.5% | 42.9 | (anonymous) 0.7%, loggedRun 0.3%, components 0.2%, stringify [native] 0.2% |
| store read | 4.8% | 37.7 | get buffer [native] 1.2%, toString [native] 0.8%, Buffer [native] 0.5%, BigInt [native] 0.5% |
| engine: caches and read sets | 2.7% | 21.1 | get buffer [native] 0.5%, find 0.3%, read 0.2%, extraSize 0.2% |
| request path: function log | 2.4% | 18.7 | withOwner 0.3%, append 0.2%, Running 0.2%, body 0.2% |
| request path: body parse and result encoding | 2.3% | 17.7 | resultSnapshot 0.9%, reformat 0.4%, parse [native] 0.4%, isJsonContentType 0.2% |
| request path: metrics and tracing | 2.1% | 16.5 | add 0.7%, metric 0.5%, recordExecution 0.2%, recordOutstanding 0.1% |
| engine: schema and shapes | 1.6% | 12.3 | fieldValue 0.6%, indexKeyValues 0.6%, map [native] 0.3%, pin 0.1% |
| request path: CORS | 0.9% | 7.3 | (anonymous) 0.3%, set [native] 0.2%, withCors 0.1%, get [native] 0.1% |
| request path: other (action-permits.ts) | 0.7% | 5.6 | run 0.4%, (anonymous) 0.2%, (anonymous) [native] 0.0%, copyUntil 0.0% |
| request path: other (streaming-export.ts) | 0.4% | 3.5 | stringify [native] 0.2%, writeValue 0.1%, fieldsOf 0.1%, filter [native] 0.1% |
| request path: other (deep-values.ts) | 0.4% | 3.3 | tooDeepToStringify 0.4%, pop [native] 0.0%, push [native] 0.0%, set [native] 0.0% |
| request path: other (errors.ts) | 0.3% | 2.2 | randomBytes [native] 0.3%, decodeCallArgs 0.0%, newRequestId 0.0% |
| request path: other (limit-warnings.ts) | 0.2% | 1.7 | functionWarnings 0.2%, approaching 0.0%, approachingDuration 0.0% |
| function | 0.1% | 0.7 | (anonymous) 0.1% |
| engine: committer | 0.1% | 0.4 | changedBetween 0.1% |
| request path: other (openapi.ts) | 0.0% | 0.4 | openApiDocAt 0.0% |
| request path: other (health.ts) | 0.0% | 0.4 | healthRoute 0.0% |
| request path: other (storage.ts) | 0.0% | 0.3 | reader 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.1 | splitComponentFunctionName 0.0% |
| request path: sync | 0.0% | 0.1 | (anonymous) 0.0% |

## postgres-insert

1471 req/s, p99 56.8 ms, errors 0.00%, server 0.66 cores (bun 0.52, JITWorker 0.10)

main thread busy 9.43 s of 22.25 s, 29443 requests, 320.2 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| engine: transactions | 23.7% | 75.8 | (anonymous) 1.6%, stage 0.9%, attempts 0.9%, intervalSetsByIndex 0.7% |
| runtime (no JS caller) | 18.1% | 57.9 | writeBuffered [native] 8.1%, (anonymous) [native] 4.9%, allocUnsafe [native] 0.4%, concat [native] 0.3% |
| request path: routing and server | 15.1% | 48.2 | fetch 3.7%, requestIP [native] 1.7%, requestVerdict 1.5%, (anonymous) 1.2% |
| values | 9.6% | 30.6 | entries [native] 1.0%, check 0.9%, sort [native] 0.9%, (anonymous) 0.8% |
| request path: function dispatch | 8.5% | 27.1 | (anonymous) 1.2%, loggedRun 0.6%, invoke 0.5%, components 0.4% |
| engine: schema and shapes | 6.5% | 20.8 | maintainedIndexes 0.6%, shapeOf 0.6%, mergeInto 0.6%, isSubtype 0.5% |
| request path: function log | 3.1% | 10.1 | withOwner 0.4%, (anonymous) 0.4%, collectLogs 0.4%, run 0.3% |
| store read | 2.8% | 9.0 | stringify [native] 2.3%, (anonymous) 0.1%, unsafe 0.1%, setTimeout [native] 0.1% |
| request path: body parse and result encoding | 2.7% | 8.6 | parse [native] 0.9%, reformat 0.5%, isJsonContentType 0.4%, fits 0.3% |
| store write | 2.2% | 6.9 | bytesToHex 0.8%, internalIdHex 0.3%, hash [native] 0.2%, apply 0.2% |
| request path: metrics and tracing | 2.1% | 6.6 | metric 0.7%, add 0.4%, recordExecution 0.2%, addGaugeMax 0.1% |
| request path: CORS | 1.3% | 4.0 | (anonymous) 0.5%, withCors 0.2%, set [native] 0.2%, hasApiCors 0.1% |
| engine: committer | 1.2% | 3.7 | writeBatchOf 0.3%, (anonymous) 0.2%, logEntryBytes 0.1%, validate 0.1% |
| request path: other (errors.ts) | 0.5% | 1.7 | randomBytes [native] 0.5% |
| request path: other (deep-values.ts) | 0.5% | 1.5 | tooDeepToStringify 0.4%, push [native] 0.0%, pop [native] 0.0%, set [native] 0.0% |
| engine: caches and read sets | 0.4% | 1.4 | derived 0.2%, (anonymous) 0.1%, constant 0.1%, over 0.0% |
| request path: other (action-permits.ts) | 0.4% | 1.4 | run 0.4%, shift [native] 0.1% |
| request path: other (limit-warnings.ts) | 0.4% | 1.3 | functionWarnings 0.3%, approaching 0.0%, approachingDuration 0.0% |
| request path: other (scheduler.ts) | 0.3% | 1.0 | makeScheduler 0.2%, (anonymous) 0.0%, resolve [native] 0.0%, some [native] 0.0% |
| function | 0.3% | 0.9 | (anonymous) 0.2%, performProxyObjectGet [native] 0.1% |
| request path: other (storage.ts) | 0.3% | 0.8 | writer 0.1%, reader 0.1%, cloneObject [native] 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.2 | observe 0.0% |
| request path: other (health.ts) | 0.0% | 0.2 | healthRoute 0.0% |
| request path: sync | 0.0% | 0.1 | onCommit 0.0%, (anonymous) 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.1 | openApiDocAt 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.1 | writeValue 0.0% |

## postgres-increment1000

423 req/s, p99 244.0 ms, errors 0.19%, server 0.58 cores (bun 0.43, JITWorker 0.12)

main thread busy 8.23 s of 22.54 s, 8500 requests, 968.4 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| runtime (no JS caller) | 41.2% | 398.8 | writeBuffered [native] 23.0%, (anonymous) [native] 4.5%, subarray [native] 1.7%, toString [native] 1.0% |
| engine: transactions | 20.3% | 197.1 | intervalSetsByIndex 1.6%, (anonymous) 1.4%, conflict 1.3%, parse [native] 0.9% |
| request path: routing and server | 6.7% | 65.2 | fetch 1.7%, requestVerdict 0.7%, (anonymous) 0.7%, requestIP [native] 0.5% |
| store read | 6.5% | 63.0 | stringify [native] 0.9%, Buffer [native] 0.7%, (anonymous) 0.7%, get buffer [native] 0.4% |
| values | 6.1% | 59.1 | entries [native] 0.7%, fromJson 0.4%, sizeOf 0.4%, (anonymous) 0.4% |
| request path: function dispatch | 4.6% | 44.8 | (anonymous) 0.7%, components 0.4%, loggedRun 0.3%, invoke 0.2% |
| engine: schema and shapes | 2.7% | 25.8 | shapeOf 0.3%, removeValue 0.2%, isSubtype 0.2%, maintainedIndexes 0.2% |
| engine: caches and read sets | 2.1% | 20.1 | read 0.7%, get buffer [native] 0.4%, fill 0.2%, toString [native] 0.1% |
| request path: function log | 1.7% | 16.5 | (anonymous) 0.2%, collectLogs 0.2%, withOwner 0.2%, walk 0.2% |
| store write | 1.5% | 14.5 | bytesToHex 0.3%, internalIdHex 0.3%, apply 0.2%, hash [native] 0.2% |
| request path: body parse and result encoding | 1.4% | 13.6 | parse [native] 0.6%, isJsonContentType 0.2%, fits 0.1%, snapshotOnSettle 0.1% |
| engine: committer | 1.4% | 13.2 | (anonymous) 0.2%, sourceAt 0.2%, writeBatchOf 0.2%, drainGroups 0.1% |
| request path: metrics and tracing | 1.3% | 12.8 | metric 0.5%, add 0.3%, recordExecution 0.2%, addGaugeMax 0.1% |
| request path: CORS | 0.7% | 7.1 | (anonymous) 0.2%, withCors 0.2%, set [native] 0.1%, get [native] 0.1% |
| request path: other (errors.ts) | 0.4% | 3.7 | randomBytes [native] 0.3%, decodeCallArgs 0.1% |
| request path: other (action-permits.ts) | 0.3% | 3.3 | run 0.2%, copyUntil 0.1%, (anonymous) 0.0% |
| request path: other (limit-warnings.ts) | 0.2% | 2.4 | functionWarnings 0.1%, approaching 0.1%, approachingDuration 0.0% |
| request path: other (deep-values.ts) | 0.2% | 1.9 | tooDeepToStringify 0.2%, pop [native] 0.0% |
| function | 0.1% | 1.3 | (anonymous) 0.1% |
| request path: other (scheduler.ts) | 0.1% | 1.1 | makeScheduler 0.1%, (anonymous) 0.0% |
| request path: other (health.ts) | 0.1% | 0.9 | healthRoute 0.1% |
| request path: other (storage.ts) | 0.1% | 0.7 | reader 0.0%, writer 0.0%, cloneObject [native] 0.0% |
| request path: other (cron-executor.ts) | 0.1% | 0.6 | some [native] 0.0%, (anonymous) 0.0%, poke 0.0% |
| request path: sync | 0.0% | 0.4 | (anonymous) 0.0%, onCommit 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.4 | openApiDocAt 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.2 | observe 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.2 | splitComponentFunctionName 0.0% |
