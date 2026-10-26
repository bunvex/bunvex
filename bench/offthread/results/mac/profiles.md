## sqlite-cached

26830 req/s, p99 2.6 ms, errors 0.00%, server 1.00 cores

main thread busy 16.11 s of 23.01 s, 536633 requests, 30.0 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| runtime (no JS caller) | 33.2% | 10.0 | (anonymous) [native] 33.2%, onBufferedFastPathSettled [native] 0.0% |
| request path: routing and server | 30.3% | 9.1 | fetch 8.4%, Response [native] 6.6%, requestIP [native] 4.1%, capped 1.6% |
| request path: function dispatch | 9.8% | 2.9 | loggedRun 1.3%, registryKey 1.1%, copyDataProperties [native] 0.8%, stringify [native] 0.7% |
| request path: function log | 6.7% | 2.0 | append 1.6%, nextUp 1.0%, withOwner 0.8%, collectLogs 0.5% |
| engine: transactions | 5.6% | 1.7 | cachedQuery 1.2%, setTimeout [native] 0.8%, (anonymous) 0.8%, now 0.6% |
| request path: CORS | 3.0% | 0.9 | set [native] 1.2%, withCors 0.8%, (anonymous) 0.6%, get [native] 0.2% |
| request path: metrics and tracing | 2.8% | 0.8 | add 0.8%, indexFor 0.6%, recordExecution 0.5%, execution 0.2% |
| values | 2.2% | 0.6 | entries [native] 0.7%, isBytes 0.5%, fromJson 0.4%, toJson 0.3% |
| request path: other (errors.ts) | 1.8% | 0.6 | randomBytes [native] 1.8%, newRequestId 0.0%, decodeCallArgs 0.0% |
| request path: body parse and result encoding | 1.6% | 0.5 | isJsonContentType 0.7%, reformat 0.3%, readJsonBody 0.3%, get [native] 0.1% |
| engine: caches and read sets | 1.2% | 0.4 | find 1.2% |
| request path: other (deep-values.ts) | 1.1% | 0.3 | tooDeepToStringify 1.1% |
| engine: committer | 0.5% | 0.1 | changedBetween 0.5% |
| request path: other (function-handles.ts) | 0.1% | 0.0 | splitComponentFunctionName 0.1% |
| store read | 0.0% | 0.0 | close [native] 0.0%, all [native] 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |

## sqlite-uncached

6571 req/s, p99 11.5 ms, errors 0.00%, server 1.05 cores

main thread busy 18.94 s of 22.42 s, 131442 requests, 144.1 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| values | 46.7% | 67.3 | entries [native] 13.7%, byteLength [native] 6.7%, valueHasLoneSurrogate 5.6%, toJson 3.6% |
| engine: transactions | 17.1% | 24.7 | parse [native] 5.4%, stringify [native] 2.5%, storeRangeOf 1.2%, now 0.5% |
| runtime (no JS caller) | 6.6% | 9.6 | (anonymous) [native] 6.6% |
| engine: caches and read sets | 6.2% | 8.9 | set 2.8%, enforceLimit 1.1%, get buffer [native] 0.4%, read 0.4% |
| request path: routing and server | 6.1% | 8.9 | Response [native] 1.7%, fetch 1.2%, requestIP [native] 0.9%, (anonymous) 0.4% |
| request path: function dispatch | 3.7% | 5.3 | (anonymous) 0.4%, loggedRun 0.2%, copyDataProperties [native] 0.2%, stringify [native] 0.2% |
| store read | 3.0% | 4.3 | all [native] 2.8%, close [native] 0.1%, Buffer [native] 0.0%, (anonymous) 0.0% |
| request path: body parse and result encoding | 2.7% | 3.9 | resultSnapshot 1.6%, reformat 0.7%, isJsonContentType 0.1%, parse [native] 0.1% |
| engine: schema and shapes | 2.3% | 3.2 | fieldValue 1.2%, indexKeyValues 0.8%, pin 0.1%, (anonymous) 0.1% |
| request path: function log | 2.0% | 2.9 | nextUp 0.2%, withOwner 0.2%, append 0.2%, collectLogs 0.2% |
| request path: metrics and tracing | 1.4% | 2.1 | add 0.4%, metric 0.3%, recordExecution 0.3%, indexFor 0.1% |
| request path: CORS | 0.6% | 0.8 | set [native] 0.2%, withCors 0.1%, (anonymous) 0.1%, get [native] 0.1% |
| request path: other (deep-values.ts) | 0.5% | 0.7 | tooDeepToStringify 0.5%, pop [native] 0.0% |
| request path: other (action-permits.ts) | 0.3% | 0.4 | shift [native] 0.1%, run 0.1%, asyncFunctionDrive [native] 0.0% |
| request path: other (errors.ts) | 0.3% | 0.4 | randomBytes [native] 0.3% |
| request path: other (streaming-export.ts) | 0.2% | 0.3 | stringify [native] 0.1%, fieldsOf 0.0%, filter [native] 0.0%, (anonymous) 0.0% |
| request path: other (limit-warnings.ts) | 0.1% | 0.1 | functionWarnings 0.1%, approaching 0.0% |
| function | 0.1% | 0.1 | (anonymous) 0.1% |
| request path: other (storage.ts) | 0.0% | 0.0 | reader 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |
| engine: committer | 0.0% | 0.0 | changedBetween 0.0% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |

## sqlite-insert

4495 req/s, p99 28.0 ms, errors 0.00%, server 0.89 cores

main thread busy 19.06 s of 22.41 s, 89914 requests, 211.9 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| store write | 70.4% | 149.1 | run [native] 69.6%, Buffer [native] 0.4%, internalIdBytes 0.2%, #run 0.1% |
| engine: transactions | 9.9% | 21.0 | (anonymous) 0.8%, slice [native] 0.7%, internalIdOf 0.5%, intervalSetsByIndex 0.5% |
| values | 4.5% | 9.5 | entries [native] 0.7%, toJson 0.4%, check 0.4%, (anonymous) 0.4% |
| request path: routing and server | 3.7% | 7.8 | fetch 1.2%, requestIP [native] 0.5%, Response [native] 0.5%, (anonymous) 0.2% |
| engine: schema and shapes | 2.9% | 6.1 | maintainedIndexes 0.4%, indexKeyValues 0.3%, entries [native] 0.2%, isSubtype 0.2% |
| request path: function dispatch | 2.2% | 4.6 | (anonymous) 0.2%, loggedRun 0.1%, invoke 0.1%, copyDataProperties [native] 0.1% |
| runtime (no JS caller) | 1.5% | 3.2 | (anonymous) [native] 1.5% |
| request path: function log | 1.1% | 2.3 | (anonymous) 0.2%, collectLogs 0.1%, append 0.1%, DataView [native] 0.1% |
| request path: body parse and result encoding | 1.1% | 2.3 | reformat 0.6%, parse [native] 0.1%, isJsonContentType 0.1%, readJsonBody 0.1% |
| request path: metrics and tracing | 0.8% | 1.7 | metric 0.2%, add 0.2%, recordExecution 0.1%, addCounter 0.1% |
| engine: committer | 0.6% | 1.3 | writeBatchOf 0.1%, drainGroups 0.1%, (anonymous) 0.1%, (anonymous) [native] 0.0% |
| request path: CORS | 0.4% | 0.8 | withCors 0.1%, set [native] 0.1%, (anonymous) 0.1%, /^\/api\/[^/]+\/sync$/ [native] 0.0% |
| request path: other (deep-values.ts) | 0.2% | 0.3 | tooDeepToStringify 0.2% |
| request path: other (errors.ts) | 0.2% | 0.3 | randomBytes [native] 0.2% |
| request path: other (action-permits.ts) | 0.2% | 0.3 | run 0.1%, shift [native] 0.0%, asyncFunctionDrive [native] 0.0% |
| request path: other (scheduler.ts) | 0.1% | 0.2 | makeScheduler 0.1%, (anonymous) 0.0%, some [native] 0.0% |
| engine: caches and read sets | 0.1% | 0.2 | derived 0.1%, constant 0.0%, matchingEntries 0.0%, (anonymous) 0.0% |
| store read | 0.1% | 0.2 | close [native] 0.1% |
| request path: other (limit-warnings.ts) | 0.1% | 0.2 | functionWarnings 0.1% |
| request path: other (storage.ts) | 0.1% | 0.2 | writer 0.1%, cloneObject [native] 0.0%, reader 0.0% |
| function | 0.1% | 0.1 | (anonymous) 0.1%, performProxyObjectGet [native] 0.0% |
| request path: other (cron-executor.ts) | 0.0% | 0.1 | some [native] 0.0%, (anonymous) 0.0% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0%, onCommit 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.0 | writeValue 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.0 | observe 0.0% |

## sqlite-increment1000

3570 req/s, p99 24.8 ms, errors 0.00%, server 0.97 cores

main thread busy 19.49 s of 23.52 s, 71643 requests, 272.1 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| store write | 43.0% | 116.9 | run [native] 42.3%, Buffer [native] 0.3%, internalIdBytes 0.2%, #run 0.1% |
| store read | 33.3% | 90.6 | all [native] 30.0%, get [native] 2.4%, latestLive 0.2%, close [native] 0.2% |
| engine: transactions | 9.9% | 27.0 | conflict 1.2%, intervalSetsByIndex 1.0%, Buffer [native] 0.7%, (anonymous) 0.5% |
| values | 2.7% | 7.3 | entries [native] 0.4%, identifierError 0.2%, sizeOf 0.2%, isBytes 0.2% |
| request path: routing and server | 1.9% | 5.2 | fetch 0.5%, requestIP [native] 0.3%, Response [native] 0.2%, (anonymous) 0.1% |
| engine: schema and shapes | 1.8% | 4.8 | maintainedIndexes 0.2%, isSubtype 0.2%, entries [native] 0.2%, shapeOf 0.1% |
| request path: function dispatch | 1.6% | 4.3 | (anonymous) 0.2%, loggedRun 0.1%, invoke 0.1%, copyDataProperties [native] 0.1% |
| engine: caches and read sets | 1.6% | 4.3 | read 0.4%, get buffer [native] 0.3%, Buffer [native] 0.2%, scan 0.1% |
| runtime (no JS caller) | 1.1% | 3.0 | (anonymous) [native] 1.1% |
| request path: function log | 0.9% | 2.3 | append 0.1%, (anonymous) 0.1%, nextUp 0.1%, ownLinesOf 0.1% |
| engine: committer | 0.8% | 2.2 | sourceAt 0.4%, drainGroups 0.0%, changedBetween 0.0%, setImmediate [native] 0.0% |
| request path: metrics and tracing | 0.6% | 1.7 | add 0.1%, recordExecution 0.1%, outstandingMetric 0.1%, metric 0.1% |
| request path: CORS | 0.2% | 0.5 | (anonymous) 0.1%, set [native] 0.1%, withCors 0.0%, pathOf 0.0% |
| request path: body parse and result encoding | 0.1% | 0.4 | isJsonContentType 0.0%, snapshotOnSettle 0.0%, reformat 0.0%, parse [native] 0.0% |
| request path: other (scheduler.ts) | 0.1% | 0.2 | (anonymous) 0.1%, makeScheduler 0.0%, some [native] 0.0% |
| request path: other (action-permits.ts) | 0.1% | 0.2 | run 0.1%, asyncFunctionDrive [native] 0.0%, shift [native] 0.0% |
| request path: other (storage.ts) | 0.1% | 0.2 | writer 0.1%, reader 0.0% |
| function | 0.1% | 0.2 | (anonymous) 0.1% |
| request path: other (errors.ts) | 0.1% | 0.2 | randomBytes [native] 0.1% |
| request path: sync | 0.1% | 0.2 | (anonymous) 0.1%, onCommit 0.0% |
| request path: other (deep-values.ts) | 0.1% | 0.1 | tooDeepToStringify 0.1% |
| request path: other (cron-executor.ts) | 0.0% | 0.1 | (anonymous) 0.0%, some [native] 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.1 | observe 0.0% |
| request path: other (limit-warnings.ts) | 0.0% | 0.0 | functionWarnings 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |
| request path: other (exports.ts) | 0.0% | 0.0 | stop 0.0% |

## postgres-cached

27154 req/s, p99 2.5 ms, errors 0.00%, server 1.01 cores

main thread busy 16.08 s of 21.41 s, 543123 requests, 29.6 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| runtime (no JS caller) | 34.2% | 10.1 | (anonymous) [native] 34.2%, performPromiseThen [native] 0.0%, end 0.0%, onBufferedFastPathSettled [native] 0.0% |
| request path: routing and server | 29.8% | 8.8 | fetch 7.8%, Response [native] 6.9%, requestIP [native] 4.6%, (anonymous) 1.5% |
| request path: function dispatch | 9.2% | 2.7 | loggedRun 1.2%, registryKey 1.2%, copyDataProperties [native] 0.9%, stringify [native] 0.7% |
| request path: function log | 7.5% | 2.2 | append 1.9%, nextUp 1.1%, withOwner 0.7%, collectLogs 0.7% |
| engine: transactions | 5.6% | 1.7 | cachedQuery 1.0%, setTimeout [native] 0.8%, now [native] 0.7%, (anonymous) 0.7% |
| request path: metrics and tracing | 2.7% | 0.8 | add 0.9%, recordExecution 0.5%, indexFor 0.4%, record 0.3% |
| request path: CORS | 2.6% | 0.8 | set [native] 1.0%, (anonymous) 0.7%, withCors 0.6%, get [native] 0.2% |
| values | 2.4% | 0.7 | entries [native] 0.9%, fromJson 0.5%, toJson 0.4%, isBytes 0.3% |
| request path: other (errors.ts) | 2.0% | 0.6 | randomBytes [native] 2.0%, newRequestId 0.0% |
| request path: body parse and result encoding | 1.6% | 0.5 | isJsonContentType 0.6%, reformat 0.4%, get [native] 0.3%, readJsonBody 0.1% |
| engine: caches and read sets | 1.2% | 0.3 | find 1.2% |
| request path: other (deep-values.ts) | 0.9% | 0.3 | tooDeepToStringify 0.9% |
| engine: committer | 0.1% | 0.0 | changedBetween 0.1% |
| request path: other (openapi.ts) | 0.1% | 0.0 | openApiDocAt 0.1% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |
| request path: other (action-permits.ts) | 0.0% | 0.0 | run 0.0% |
| store read | 0.0% | 0.0 | Query 0.0% |

## postgres-uncached

6404 req/s, p99 12.4 ms, errors 0.00%, server 1.06 cores

main thread busy 18.57 s of 22.37 s, 128103 requests, 144.9 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| values | 46.6% | 67.5 | entries [native] 12.6%, byteLength [native] 6.1%, valueHasLoneSurrogate 5.7%, toJson 4.7% |
| engine: transactions | 14.9% | 21.6 | parse [native] 3.5%, stringify [native] 2.8%, storeRangeOf 0.7%, (anonymous) 0.6% |
| runtime (no JS caller) | 10.7% | 15.6 | (anonymous) [native] 7.8%, toString [native] 0.7%, Buffer [native] 0.5%, subarray [native] 0.3% |
| engine: caches and read sets | 6.2% | 9.0 | set 3.0%, enforceLimit 1.0%, get buffer [native] 0.4%, delete 0.4% |
| request path: routing and server | 5.9% | 8.5 | Response [native] 1.8%, fetch 1.1%, requestIP [native] 0.9%, (anonymous) 0.4% |
| request path: function dispatch | 3.4% | 5.0 | (anonymous) 0.3%, loggedRun 0.3%, copyDataProperties [native] 0.2%, warned 0.2% |
| request path: body parse and result encoding | 2.8% | 4.1 | resultSnapshot 1.6%, reformat 0.9%, parse [native] 0.1%, snapshotOnSettle 0.1% |
| request path: function log | 2.2% | 3.3 | append 0.5%, withOwner 0.3%, nextUp 0.3%, collectLogs 0.2% |
| engine: schema and shapes | 2.2% | 3.2 | fieldValue 0.9%, indexKeyValues 0.7%, map [native] 0.4%, pin 0.1% |
| request path: metrics and tracing | 1.7% | 2.5 | add 0.5%, metric 0.5%, recordExecution 0.2%, indexFor 0.2% |
| store read | 1.2% | 1.7 | get buffer [native] 0.2%, Buffer [native] 0.2%, (anonymous) 0.1%, toString [native] 0.1% |
| request path: CORS | 0.7% | 1.0 | set [native] 0.3%, withCors 0.2%, (anonymous) 0.2%, get [native] 0.1% |
| request path: other (deep-values.ts) | 0.3% | 0.5 | tooDeepToStringify 0.3%, pop [native] 0.0% |
| request path: other (errors.ts) | 0.3% | 0.4 | randomBytes [native] 0.3%, newRequestId 0.0% |
| request path: other (action-permits.ts) | 0.2% | 0.3 | run 0.2%, (anonymous) 0.0%, Frame 0.0%, asyncFunctionDrive [native] 0.0% |
| store write | 0.2% | 0.3 | toString [native] 0.1%, get buffer [native] 0.0%, BigInt [native] 0.0%, Buffer [native] 0.0% |
| request path: other (streaming-export.ts) | 0.2% | 0.2 | stringify [native] 0.1%, fieldsOf 0.0%, filter [native] 0.0%, map [native] 0.0% |
| function | 0.1% | 0.1 | (anonymous) 0.1% |
| request path: other (limit-warnings.ts) | 0.0% | 0.1 | functionWarnings 0.0% |
| request path: other (storage.ts) | 0.0% | 0.1 | reader 0.0% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0%, stop 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| engine: committer | 0.0% | 0.0 | wakeVisible 0.0% |

## postgres-insert

5202 req/s, p99 13.2 ms, errors 0.00%, server 0.69 cores

main thread busy 11.34 s of 21.51 s, 104064 requests, 109.0 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| engine: transactions | 26.6% | 29.0 | (anonymous) 2.2%, Buffer [native] 1.8%, slice [native] 1.8%, intervalSetsByIndex 1.3% |
| runtime (no JS caller) | 14.3% | 15.6 | (anonymous) [native] 7.1%, writeBuffered [native] 2.0%, subarray [native] 0.3%, Buffer [native] 0.3% |
| request path: routing and server | 11.8% | 12.9 | fetch 3.8%, requestIP [native] 1.5%, Response [native] 1.1%, (anonymous) 0.6% |
| values | 11.7% | 12.8 | entries [native] 1.6%, sort [native] 1.0%, check 1.0%, (anonymous) 1.0% |
| engine: schema and shapes | 7.6% | 8.3 | next [native] 1.0%, fieldValue 0.6%, mergeInto 0.6%, isSubtype 0.5% |
| request path: function dispatch | 5.8% | 6.3 | (anonymous) 0.7%, invoke 0.4%, loggedRun 0.4%, completion 0.3% |
| store write | 4.7% | 5.1 | keyColumns 1.0%, internalIdHex 0.7%, bytesToHex 0.7%, hash [native] 0.7% |
| request path: body parse and result encoding | 3.4% | 3.7 | reformat 1.7%, parse [native] 0.6%, isJsonContentType 0.3%, snapshotOnSettle 0.3% |
| store read | 3.1% | 3.4 | stringify [native] 2.8%, (anonymous) 0.1%, setTimeout [native] 0.0%, arm 0.0% |
| request path: function log | 2.6% | 2.9 | append 0.4%, (anonymous) 0.3%, walk 0.2%, withOwner 0.2% |
| engine: committer | 2.3% | 2.5 | drainGroups 0.3%, writeBatchOf 0.3%, map [native] 0.3%, compare [native] 0.2% |
| request path: metrics and tracing | 2.0% | 2.2 | metric 0.8%, add 0.3%, recordExecution 0.3%, indexFor 0.2% |
| request path: CORS | 1.3% | 1.4 | (anonymous) 0.3%, set [native] 0.3%, withCors 0.3%, set 0.1% |
| request path: other (errors.ts) | 0.7% | 0.7 | randomBytes [native] 0.6%, decodeCallArgs 0.0% |
| request path: other (action-permits.ts) | 0.5% | 0.5 | run 0.4%, shift [native] 0.1% |
| request path: other (deep-values.ts) | 0.3% | 0.3 | tooDeepToStringify 0.3% |
| function | 0.3% | 0.3 | (anonymous) 0.3%, performProxyObjectGet [native] 0.0% |
| request path: other (scheduler.ts) | 0.2% | 0.3 | some [native] 0.1%, makeScheduler 0.1%, (anonymous) 0.1% |
| request path: other (storage.ts) | 0.2% | 0.2 | writer 0.1%, reader 0.1% |
| engine: caches and read sets | 0.2% | 0.2 | derived 0.1%, matchingEntries 0.0%, (anonymous) 0.0%, constant 0.0% |
| request path: other (limit-warnings.ts) | 0.1% | 0.1 | functionWarnings 0.1% |
| request path: other (cron-executor.ts) | 0.1% | 0.1 | (anonymous) 0.1%, some [native] 0.0% |
| request path: other (executor-invalidations.ts) | 0.1% | 0.1 | observe 0.1% |
| request path: other (streaming-export.ts) | 0.0% | 0.0 | writeValue 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |

## postgres-increment1000

3212 req/s, p99 33.0 ms, errors 0.00%, server 0.96 cores

main thread busy 14.35 s of 22.02 s, 64296 requests, 223.2 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| engine: transactions | 32.3% | 72.0 | conflict 3.5%, Buffer [native] 2.0%, intervalSetsByIndex 2.0%, (anonymous) 1.7% |
| runtime (no JS caller) | 21.7% | 48.4 | (anonymous) [native] 5.8%, writeBuffered [native] 3.6%, subarray [native] 1.1%, toString [native] 0.9% |
| values | 9.3% | 20.7 | entries [native] 1.3%, isBytes 0.8%, byteLength [native] 0.7%, sizeOf 0.6% |
| request path: routing and server | 7.1% | 15.7 | fetch 1.5%, requestIP [native] 1.1%, Response [native] 0.7%, (anonymous) 0.5% |
| store read | 6.8% | 15.3 | stringify [native] 1.3%, Buffer [native] 0.8%, (anonymous) 0.6%, then [native] 0.5% |
| request path: function dispatch | 5.6% | 12.5 | (anonymous) 1.2%, invoke 0.4%, loggedRun 0.4%, warned 0.3% |
| engine: schema and shapes | 3.4% | 7.6 | fieldValue 0.5%, next [native] 0.3%, entries [native] 0.3%, isSubtype 0.3% |
| store write | 2.7% | 6.0 | apply 0.3%, internalIdHex 0.3%, bytesToHex 0.3%, hash [native] 0.3% |
| engine: caches and read sets | 2.2% | 5.0 | read 0.6%, get buffer [native] 0.4%, fill 0.2%, toString [native] 0.2% |
| request path: function log | 2.0% | 4.5 | (anonymous) 0.3%, walk 0.3%, withOwner 0.2%, run 0.2% |
| engine: committer | 1.8% | 4.0 | sourceAt 0.4%, writeBatchOf 0.2%, drainGroups 0.2%, sort [native] 0.2% |
| request path: metrics and tracing | 1.6% | 3.7 | metric 0.6%, add 0.4%, recordExecution 0.2%, f32Safe 0.1% |
| request path: body parse and result encoding | 0.8% | 1.7 | reformat 0.2%, isJsonContentType 0.2%, readJsonBody 0.1%, parse [native] 0.1% |
| request path: CORS | 0.6% | 1.4 | set [native] 0.2%, (anonymous) 0.2%, withCors 0.1%, set 0.1% |
| request path: other (action-permits.ts) | 0.5% | 1.2 | run 0.5%, (anonymous) 0.1%, wait 0.0%, set 0.0% |
| request path: other (storage.ts) | 0.4% | 0.8 | writer 0.3%, reader 0.0%, cloneObject [native] 0.0% |
| request path: other (errors.ts) | 0.3% | 0.7 | randomBytes [native] 0.3%, decodeCallArgs 0.0% |
| function | 0.3% | 0.6 | (anonymous) 0.3% |
| request path: other (scheduler.ts) | 0.2% | 0.4 | makeScheduler 0.1%, (anonymous) 0.1%, some [native] 0.1% |
| request path: other (deep-values.ts) | 0.1% | 0.2 | tooDeepToStringify 0.1% |
| request path: other (limit-warnings.ts) | 0.1% | 0.2 | functionWarnings 0.1%, approaching 0.0% |
| request path: other (cron-executor.ts) | 0.1% | 0.2 | some [native] 0.1%, (anonymous) 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.1 | observe 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |
| request path: other (health.ts) | 0.0% | 0.0 | healthRoute 0.0% |
| request path: sync | 0.0% | 0.0 | onCommit 0.0% |

