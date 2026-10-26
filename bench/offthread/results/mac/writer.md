## sqlite-insert

5704 req/s, p99 24.2 ms, errors 0.00%, server 1.07 cores

main thread busy 4.16 s of 11.72 s, 57057 requests, 72.9 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| engine: transactions | 33.0% | 24.0 | (anonymous) 2.3%, Buffer [native] 1.9%, slice [native] 1.5%, internalIdOf 1.4% |
| request path: routing and server | 14.9% | 10.9 | fetch 4.9%, requestIP [native] 2.0%, Response [native] 1.3%, text [native] 0.9% |
| values | 14.6% | 10.6 | entries [native] 2.2%, toJson 1.3%, check 1.1%, (anonymous) 1.0% |
| engine: schema and shapes | 7.9% | 5.8 | next [native] 0.9%, isSubtype 0.8%, maintainedIndexes 0.7%, entries [native] 0.6% |
| request path: function dispatch | 5.7% | 4.2 | (anonymous) 1.2%, invoke 0.4%, loggedRun 0.3%, warned 0.3% |
| runtime (no JS caller) | 5.2% | 3.8 | (anonymous) [native] 5.2% |
| function | 4.6% | 3.4 | postMessage [native] 4.3%, (anonymous) 0.1%, apply 0.1%, performProxyObjectGet [native] 0.0% |
| request path: body parse and result encoding | 3.0% | 2.2 | reformat 1.3%, isJsonContentType 0.6%, readJsonBody 0.2%, parse [native] 0.1% |
| request path: function log | 3.0% | 2.2 | (anonymous) 0.4%, collectLogs 0.3%, withOwner 0.3%, nextUp 0.3% |
| request path: metrics and tracing | 2.2% | 1.6 | metric 1.0%, add 0.6%, recordExecution 0.2%, addCounter 0.1% |
| engine: committer | 1.9% | 1.4 | writeBatchOf 0.2%, drainGroups 0.2%, cloneObject [native] 0.2%, map [native] 0.2% |
| request path: CORS | 1.1% | 0.8 | withCors 0.3%, (anonymous) 0.3%, set [native] 0.1%, set 0.1% |
| request path: other (limit-warnings.ts) | 0.5% | 0.4 | functionWarnings 0.5%, approaching 0.0% |
| request path: other (errors.ts) | 0.5% | 0.3 | randomBytes [native] 0.4%, decodeCallArgs 0.1% |
| request path: other (action-permits.ts) | 0.4% | 0.3 | run 0.2%, asyncFunctionDrive [native] 0.1%, shift [native] 0.1% |
| request path: other (deep-values.ts) | 0.4% | 0.3 | tooDeepToStringify 0.4% |
| request path: other (storage.ts) | 0.3% | 0.2 | writer 0.2%, reader 0.0%, cloneObject [native] 0.0% |
| engine: caches and read sets | 0.3% | 0.2 | derived 0.2%, constant 0.1%, (anonymous) 0.0% |
| store read | 0.1% | 0.1 | close [native] 0.1% |
| request path: other (cron-executor.ts) | 0.1% | 0.1 | (anonymous) 0.1% |
| request path: other (scheduler.ts) | 0.1% | 0.1 | makeScheduler 0.0%, (anonymous) 0.0% |
| request path: other (executor-invalidations.ts) | 0.1% | 0.1 | observe 0.1% |
| store write | 0.0% | 0.0 | run [native] 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |
| request path: sync | 0.0% | 0.0 | (anonymous) 0.0% |
| request path: other (exports.ts) | 0.0% | 0.0 | stop 0.0% |

## sqlite-increment1000

4491 req/s, p99 21.4 ms, errors 0.00%, server 1.29 cores

main thread busy 7.55 s of 12.39 s, 44978 requests, 168.0 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| store read | 48.0% | 80.6 | all [native] 41.3%, get [native] 5.3%, latestLive 0.4%, Buffer [native] 0.2% |
| engine: transactions | 22.0% | 36.9 | intervalSetsByIndex 2.6%, conflict 2.5%, Buffer [native] 1.4%, (anonymous) 0.9% |
| values | 5.9% | 9.9 | entries [native] 0.8%, byteLength [native] 0.5%, sizeOf 0.5%, identifierError 0.4% |
| request path: routing and server | 4.8% | 8.1 | fetch 1.4%, Response [native] 0.6%, requestIP [native] 0.5%, (anonymous) 0.4% |
| engine: caches and read sets | 3.1% | 5.2 | read 0.8%, get buffer [native] 0.7%, scan 0.4%, (anonymous) [native] 0.3% |
| request path: function dispatch | 3.1% | 5.1 | (anonymous) 0.5%, invoke 0.3%, loggedRun 0.2%, cloneObject [native] 0.2% |
| engine: schema and shapes | 2.9% | 4.8 | entries [native] 0.4%, shapeOf 0.3%, isSubtype 0.2%, maintainedIndexes 0.2% |
| function | 2.5% | 4.1 | postMessage [native] 2.2%, (anonymous) 0.2%, resolvePromiseWithFirstResolvingFunctionCallCheck [native] 0.0%, call 0.0% |
| runtime (no JS caller) | 2.4% | 4.0 | (anonymous) [native] 2.4% |
| request path: function log | 1.3% | 2.2 | (anonymous) 0.2%, withOwner 0.2%, usageStats 0.1%, run 0.1% |
| engine: committer | 1.3% | 2.2 | sourceAt 0.3%, changedBetween 0.2%, writeBatchOf 0.1%, drainGroups 0.1% |
| request path: CORS | 0.7% | 1.1 | set [native] 0.3%, (anonymous) 0.1%, get [native] 0.1%, withCors 0.1% |
| request path: metrics and tracing | 0.6% | 1.0 | metric 0.2%, add 0.2%, recordExecution 0.0%, indexFor 0.0% |
| request path: body parse and result encoding | 0.5% | 0.9 | isJsonContentType 0.1%, get [native] 0.1%, reformat 0.1%, snapshotOnSettle 0.1% |
| request path: other (errors.ts) | 0.3% | 0.4 | randomBytes [native] 0.2%, decodeCallArgs 0.0% |
| request path: other (deep-values.ts) | 0.2% | 0.3 | tooDeepToStringify 0.2%, set [native] 0.0%, pop [native] 0.0% |
| request path: other (storage.ts) | 0.2% | 0.3 | reader 0.1%, writer 0.1%, cloneObject [native] 0.0% |
| request path: other (action-permits.ts) | 0.1% | 0.2 | run 0.1% |
| request path: other (scheduler.ts) | 0.1% | 0.2 | makeScheduler 0.1%, (anonymous) 0.1% |
| request path: other (openapi.ts) | 0.1% | 0.1 | openApiDocAt 0.1% |
| request path: other (cron-executor.ts) | 0.1% | 0.1 | some [native] 0.0%, (anonymous) 0.0% |
| request path: other (limit-warnings.ts) | 0.1% | 0.1 | functionWarnings 0.1% |
| request path: sync | 0.1% | 0.1 | (anonymous) 0.0%, onCommit 0.0% |
| request path: other (executor-invalidations.ts) | 0.0% | 0.1 | observe 0.0% |
| store write | 0.0% | 0.0 | run [native] 0.0% |
