## sqlite-uncached

7558 req/s, p99 8.5 ms, errors 0.00%, server 1.33 cores

main thread busy 9.60 s of 12.82 s, 75648 requests, 126.9 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| values | 51.5% | 65.4 | entries [native] 13.6%, byteLength [native] 7.7%, valueHasLoneSurrogate 6.6%, sizeOf 4.6% |
| engine: transactions | 17.5% | 22.2 | parse [native] 4.7%, stringify [native] 2.6%, storeRangeOf 1.4%, (anonymous) 0.7% |
| runtime (no JS caller) | 6.3% | 7.9 | (anonymous) [native] 6.3% |
| engine: caches and read sets | 5.6% | 7.1 | set 2.6%, enforceLimit 0.9%, delete 0.4%, get buffer [native] 0.3% |
| request path: routing and server | 4.7% | 6.0 | Response [native] 1.5%, fetch 1.0%, requestIP [native] 0.6%, (anonymous) 0.3% |
| request path: function dispatch | 3.2% | 4.1 | (anonymous) 0.5%, loggedRun 0.2%, invoke 0.2%, withAudit 0.2% |
| request path: body parse and result encoding | 2.5% | 3.2 | resultSnapshot 1.5%, reformat 0.7%, snapshotOnSettle 0.1%, isJsonContentType 0.1% |
| engine: schema and shapes | 2.4% | 3.0 | fieldValue 1.2%, indexKeyValues 0.8%, pin 0.2%, map [native] 0.1% |
| request path: function log | 1.9% | 2.5 | append 0.3%, nextUp 0.3%, withOwner 0.2%, run 0.1% |
| request path: metrics and tracing | 1.8% | 2.3 | add 0.5%, metric 0.4%, recordExecution 0.3%, addGaugeMax 0.2% |
| request path: CORS | 0.8% | 1.0 | (anonymous) 0.2%, set [native] 0.2%, withCors 0.2%, get [native] 0.1% |
| function | 0.5% | 0.7 | postMessage [native] 0.4%, scan 0.0%, (anonymous) 0.0%, call 0.0% |
| request path: other (deep-values.ts) | 0.3% | 0.4 | tooDeepToStringify 0.3% |
| request path: other (errors.ts) | 0.2% | 0.3 | randomBytes [native] 0.2% |
| request path: other (action-permits.ts) | 0.2% | 0.3 | run 0.2%, Frame 0.0%, asyncFunctionDrive [native] 0.0% |
| request path: other (streaming-export.ts) | 0.2% | 0.3 | stringify [native] 0.1%, fieldsOf 0.1%, (anonymous) 0.0%, filter [native] 0.0% |
| request path: other (limit-warnings.ts) | 0.1% | 0.1 | functionWarnings 0.1%, approaching 0.0% |
| request path: other (storage.ts) | 0.1% | 0.1 | reader 0.1% |
| store read | 0.1% | 0.1 | close [native] 0.1% |
| engine: committer | 0.0% | 0.0 | changedBetween 0.0% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |
| store write | 0.0% | 0.0 | run [native] 0.0% |

## sqlite-increment1000

5053 req/s, p99 22.7 ms, errors 0.00%, server 1.67 cores

main thread busy 5.79 s of 12.29 s, 50547 requests, 114.6 µs/request
| bucket | share | µs/request | top leaves |
|---|---:|---:|---|
| engine: transactions | 32.6% | 37.4 | conflict 4.2%, intervalSetsByIndex 3.2%, Buffer [native] 2.7%, (anonymous) 2.0% |
| function | 19.0% | 21.8 | postMessage [native] 18.0%, (anonymous) 0.5%, call 0.2%, Promise [native] 0.2% |
| request path: routing and server | 11.0% | 12.6 | fetch 3.8%, requestIP [native] 1.3%, Response [native] 0.9%, capped 0.6% |
| values | 8.6% | 9.9 | entries [native] 1.3%, byteLength [native] 0.8%, identifierError 0.6%, isBytes 0.5% |
| request path: function dispatch | 5.8% | 6.7 | (anonymous) 1.3%, loggedRun 0.4%, invoke 0.3%, asyncFunctionDrive [native] 0.2% |
| engine: schema and shapes | 5.2% | 6.0 | entries [native] 0.6%, shapeOf 0.6%, isSubtype 0.5%, next [native] 0.5% |
| runtime (no JS caller) | 4.1% | 4.7 | (anonymous) [native] 4.1% |
| engine: caches and read sets | 3.3% | 3.8 | get buffer [native] 0.9%, read 0.8%, toString [native] 0.3%, Buffer [native] 0.2% |
| request path: function log | 2.7% | 3.0 | (anonymous) 0.6%, run 0.3%, withOwner 0.3%, append 0.3% |
| engine: committer | 2.2% | 2.5 | sourceAt 0.6%, writeBatchOf 0.4%, compare [native] 0.4%, drainGroups 0.2% |
| request path: metrics and tracing | 1.4% | 1.6 | metric 0.4%, add 0.3%, addCounter 0.2%, indexFor 0.1% |
| request path: body parse and result encoding | 1.0% | 1.1 | isJsonContentType 0.3%, snapshotOnSettle 0.2%, reformat 0.2%, readJsonBody 0.1% |
| request path: CORS | 0.9% | 1.1 | (anonymous) 0.3%, set [native] 0.1%, withCors 0.1%, set 0.1% |
| request path: other (errors.ts) | 0.4% | 0.4 | randomBytes [native] 0.4%, decodeCallArgs 0.0% |
| request path: other (action-permits.ts) | 0.3% | 0.4 | run 0.3%, (anonymous) 0.0%, asyncFunctionDrive [native] 0.0% |
| request path: other (storage.ts) | 0.3% | 0.4 | reader 0.2%, writer 0.1% |
| request path: other (deep-values.ts) | 0.3% | 0.3 | tooDeepToStringify 0.3% |
| request path: other (cron-executor.ts) | 0.2% | 0.2 | (anonymous) 0.2%, some [native] 0.0% |
| request path: other (executor-invalidations.ts) | 0.1% | 0.1 | observe 0.1%, (anonymous) 0.0% |
| request path: other (scheduler.ts) | 0.1% | 0.1 | (anonymous) 0.1%, some [native] 0.0% |
| request path: other (limit-warnings.ts) | 0.1% | 0.1 | functionWarnings 0.1%, clear [native] 0.0% |
| request path: sync | 0.1% | 0.1 | onCommit 0.1%, (anonymous) 0.0% |
| store write | 0.1% | 0.1 | run [native] 0.1% |
| request path: other (openapi.ts) | 0.0% | 0.0 | openApiDocAt 0.0% |
| store read | 0.0% | 0.0 | close [native] 0.0% |
