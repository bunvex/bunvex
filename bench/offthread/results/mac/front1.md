## sqlite-cached

37868 req/s, p99 2.3 ms, errors 0.00%, server 1.77 cores

main thread busy 4.45 s of 8.27 s, 227223 requests, 19.6 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| request path: routing and server | 38.1% | 7.5 | fetch 13.4%, Response [native] 9.8%, capped 2.5%, text [native] 2.2% |
| prototype: thread messages | 19.6% | 3.8 | postMessage [native] 11.8%, next [native] 2.4%, Request [native] 2.3%, (anonymous) 1.8% |
| request path: function dispatch | 10.2% | 2.0 | loggedRun 1.3%, registryKey 1.2%, stringify [native] 0.9%, copyDataProperties [native] 0.8% |
| engine: transactions | 9.2% | 1.8 | cachedQuery 1.7%, now [native] 1.5%, setTimeout [native] 1.3%, now 1.3% |
| request path: function log | 7.5% | 1.5 | append 2.1%, nextUp 1.5%, withOwner 0.6%, collectLogs 0.6% |
| request path: CORS | 3.5% | 0.7 | set [native] 1.2%, (anonymous) 0.8%, withCors 0.7%, get [native] 0.2% |
| request path: metrics and tracing | 2.9% | 0.6 | add 1.0%, recordExecution 0.5%, indexFor 0.5%, (anonymous) 0.3% |
| values | 2.2% | 0.4 | entries [native] 0.7%, isBytes 0.6%, toJson 0.4%, fromJson 0.3% |
| request path: body parse and result encoding | 1.7% | 0.3 | isJsonContentType 0.7%, reformat 0.4%, readJsonBody 0.2%, get [native] 0.2% |
| engine: caches and read sets | 1.4% | 0.3 | find 1.4%, putReady 0.0% |
| request path: other (errors.ts) | 1.3% | 0.3 | randomBytes [native] 1.3% |
| request path: other (deep-values.ts) | 1.2% | 0.2 | tooDeepToStringify 1.2% |
| engine: committer | 0.5% | 0.1 | changedBetween 0.5%, (anonymous) 0.0% |
| store read | 0.3% | 0.1 | close [native] 0.2%, all [native] 0.0% |
| request path: other (openapi.ts) | 0.2% | 0.0 | openApiDocAt 0.2% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0% |
| request path: other (function-handles.ts) | 0.0% | 0.0 | splitComponentFunctionName 0.0% |
| store write | 0.0% | 0.0 | run [native] 0.0% |

## sqlite-insert

4408 req/s, p99 33.2 ms, errors 0.00%, server 0.95 cores

main thread busy 5.66 s of 8.20 s, 26460 requests, 213.7 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| store write | 71.8% | 153.4 | run [native] 70.9%, internalIdBytes 0.4%, Buffer [native] 0.3%, #run 0.0% |
| engine: transactions | 9.0% | 19.3 | Buffer [native] 1.1%, (anonymous) 0.5%, intervalSetsByIndex 0.4%, stage 0.3% |
| request path: routing and server | 3.9% | 8.4 | fetch 1.2%, Response [native] 0.4%, capped 0.3%, get [native] 0.3% |
| values | 3.5% | 7.5 | entries [native] 0.5%, byteLength [native] 0.3%, valueHasLoneSurrogate 0.3%, sort [native] 0.2% |
| engine: schema and shapes | 2.3% | 4.9 | entries [native] 0.3%, maintainedIndexes 0.3%, next [native] 0.3%, shapeOf 0.2% |
| request path: function dispatch | 2.2% | 4.8 | (anonymous) 0.3%, loggedRun 0.2%, strippedPath 0.2%, invoke 0.1% |
| engine: committer | 1.2% | 2.6 | writeBatchOf 0.3%, drainGroups 0.2%, sort [native] 0.1%, validate 0.1% |
| request path: function log | 1.0% | 2.2 | walk 0.2%, withOwner 0.1%, run 0.1%, (anonymous) 0.1% |
| request path: metrics and tracing | 1.0% | 2.2 | metric 0.3%, add 0.3%, addCounter 0.1%, recordExecution 0.1% |
| prototype: thread messages | 0.9% | 2.0 | Request [native] 0.5%, postMessage [native] 0.2%, (anonymous) 0.1%, next [native] 0.1% |
| request path: body parse and result encoding | 0.9% | 1.9 | reformat 0.6%, parse [native] 0.1%, isJsonContentType 0.1%, stringify [native] 0.1% |
| store read | 0.6% | 1.4 | close [native] 0.6% |
| request path: CORS | 0.3% | 0.7 | set [native] 0.1%, (anonymous) 0.1%, get [native] 0.0%, hasApiCors 0.0% |
| request path: other (errors.ts) | 0.3% | 0.6 | randomBytes [native] 0.3% |
| request path: other (deep-values.ts) | 0.2% | 0.4 | tooDeepToStringify 0.2% |
| request path: other (limit-warnings.ts) | 0.1% | 0.3 | functionWarnings 0.1%, approaching 0.0% |
| request path: other (action-permits.ts) | 0.1% | 0.3 | run 0.1%, shift [native] 0.0%, asyncFunctionDrive [native] 0.0% |
| request path: other (storage.ts) | 0.1% | 0.3 | cloneObject [native] 0.1%, writer 0.0% |
| request path: other (cron-executor.ts) | 0.1% | 0.2 | (anonymous) 0.0%, some [native] 0.0% |
| request path: sync | 0.1% | 0.2 | (anonymous) 0.0%, onCommit 0.0% |
| request path: other (streaming-export.ts) | 0.0% | 0.1 | writeValue 0.0% |
| request path: other (scheduler.ts) | 0.0% | 0.1 | (anonymous) 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.1 | openApiDocAt 0.0% |
| engine: caches and read sets | 0.0% | 0.1 | matchingEntries 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.1 | observe 0.0% |
| request path: other (health.ts) | 0.0% | 0.1 | healthRoute 0.0% |
| function | 0.0% | 0.1 | (anonymous) 0.0% |
