# STUDY-136 index cache, end to end — raw runs, 2026-10-11

`bench/index-cache-e2e.ts` on an Apple Silicon Mac: `bunvex-local-backend` (run by Bun) over Postgres 17 (Homebrew, same machine), the app in `bench/index-cache-e2e/` pushed with `bunvex deploy`, 4 load processes × 16 HTTP clients on the same machine. Phase 1 is a warm-up. Summary in [STUDY-136 §3.5](../study/STUDY-136-index-cache.md#35-end-to-end).

## WRITE_PCT=10

```json
{"CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":10,"WORKERS":4,"CONC":16,"SECS":20,"ROUNDS":2,"SKEW":1,"seedMs":2912}
{"phase":1,"indexCache":"off","opsPerSec":2711,"queriesPerSec":2444,"mutationsPerSec":267,"queryP50":16.53,"queryP99":37.81,"mutationP50":89.46,"mutationP99":190.98,"errors":0,"queryCacheHitRate":0.086,"indexCacheHitRate":0,"indexCacheMB":0,"storeTxPerSec":10030,"storeTxPerOp":3.7}
{"phase":2,"indexCache":"off","opsPerSec":2771,"queriesPerSec":2488,"mutationsPerSec":283,"queryP50":12.94,"queryP99":29.68,"mutationP50":114.16,"mutationP99":193.32,"errors":0,"queryCacheHitRate":0.083,"indexCacheHitRate":0,"indexCacheMB":0,"storeTxPerSec":10278,"storeTxPerOp":3.71}
{"phase":3,"indexCache":"on","opsPerSec":5824,"queriesPerSec":5246,"mutationsPerSec":578,"queryP50":0.62,"queryP99":7.3,"mutationP50":98.83,"mutationP99":155.57,"errors":0,"queryCacheHitRate":0.093,"indexCacheHitRate":0.945,"indexCacheMB":16,"storeTxPerSec":1423,"storeTxPerOp":0.24}
{"phase":4,"indexCache":"off","opsPerSec":2670,"queriesPerSec":2400,"mutationsPerSec":270,"queryP50":13.76,"queryP99":34.02,"mutationP50":108.67,"mutationP99":386.28,"errors":0,"queryCacheHitRate":0.088,"indexCacheHitRate":0,"indexCacheMB":0,"storeTxPerSec":10078,"storeTxPerOp":3.77}
{"phase":5,"indexCache":"on","opsPerSec":5966,"queriesPerSec":5367,"mutationsPerSec":599,"queryP50":0.6,"queryP99":8.22,"mutationP50":95.51,"mutationP99":150.89,"errors":0,"queryCacheHitRate":0.093,"indexCacheHitRate":0.945,"indexCacheMB":16.1,"storeTxPerSec":1461,"storeTxPerOp":0.24}
```

## WRITE_PCT=50

```json
{"CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":50,"WORKERS":4,"CONC":16,"SECS":20,"ROUNDS":2,"SKEW":1,"seedMs":2692}
{"phase":1,"indexCache":"off","opsPerSec":1937,"queriesPerSec":970,"mutationsPerSec":967,"queryP50":2.68,"queryP99":7.87,"mutationP50":61.33,"mutationP99":101.37,"errors":0,"queryCacheHitRate":0.015,"indexCacheHitRate":0,"indexCacheMB":0,"storeTxPerSec":8159,"storeTxPerOp":4.21}
{"phase":2,"indexCache":"off","opsPerSec":1973,"queriesPerSec":991,"mutationsPerSec":983,"queryP50":2.68,"queryP99":7.88,"mutationP50":60.99,"mutationP99":92.71,"errors":0,"queryCacheHitRate":0.016,"indexCacheHitRate":0,"indexCacheMB":0,"storeTxPerSec":8560,"storeTxPerOp":4.34}
{"phase":3,"indexCache":"on","opsPerSec":3188,"queriesPerSec":1589,"mutationsPerSec":1599,"queryP50":0.81,"queryP99":4.19,"mutationP50":37.62,"mutationP99":61.84,"errors":0,"queryCacheHitRate":0.016,"indexCacheHitRate":0.901,"indexCacheMB":15.4,"storeTxPerSec":1988,"storeTxPerOp":0.62}
{"phase":4,"indexCache":"off","opsPerSec":1913,"queriesPerSec":958,"mutationsPerSec":955,"queryP50":2.76,"queryP99":7.37,"mutationP50":63.16,"mutationP99":87.63,"errors":35,"firstError":"Error: [Request ID: 25734d30b2b5bdb3] Server Error\nCould not find public function for 'chat:list'.\n","queryCacheHitRate":0.015,"indexCacheHitRate":0,"indexCacheMB":0,"storeTxPerSec":8331,"storeTxPerOp":4.36}
{"phase":5,"indexCache":"on","opsPerSec":3181,"queriesPerSec":1592,"mutationsPerSec":1589,"queryP50":0.82,"queryP99":3.58,"mutationP50":38.11,"mutationP99":58.92,"errors":0,"queryCacheHitRate":0.015,"indexCacheHitRate":0.901,"indexCacheMB":15.4,"storeTxPerSec":1991,"storeTxPerOp":0.63}
```
