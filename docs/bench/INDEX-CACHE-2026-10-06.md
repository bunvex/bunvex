# STUDY-136 index cache — raw runs, 2026-10-06

`bench/index-cache.ts` on an Apple Silicon Mac; Postgres 17 in Docker on the same machine. Phase 1 is a warm-up. Summary in [STUDY-136 §3.4](../study/STUDY-136-index-cache.md#34-measurement).

## pg-mixed

```json
{"KIND":"postgres","SCENARIO":"mixed","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":10,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":1,"seedMs":5953}
{"phase":1,"indexCache":"off","opsPerSec":2431,"queriesPerSec":2189,"mutationsPerSec":242,"queryP50":11.383,"queryP99":24.104,"mutationP50":27.434,"mutationP99":50.905,"queryCacheHitRate":0.08,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.784,"storeCallsPerSec":6766}
{"phase":2,"indexCache":"off","opsPerSec":2206,"queriesPerSec":1986,"mutationsPerSec":220,"queryP50":11.751,"queryP99":45.412,"mutationP50":28.058,"mutationP99":106.279,"queryCacheHitRate":0.079,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.787,"storeCallsPerSec":6149}
{"phase":3,"indexCache":"on","opsPerSec":9137,"queriesPerSec":8208,"mutationsPerSec":929,"queryP50":0.08,"queryP99":12.074,"mutationP50":20.025,"mutationP99":71.39,"queryCacheHitRate":0.091,"indexCacheHitRate":0.91,"indexCacheMB":7.9,"storeCallsPerOp":0.249,"storeCallsPerSec":2273}
{"phase":4,"indexCache":"off","opsPerSec":2314,"queriesPerSec":2083,"mutationsPerSec":231,"queryP50":11.766,"queryP99":33.437,"mutationP50":27.719,"mutationP99":62.254,"queryCacheHitRate":0.077,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.792,"storeCallsPerSec":6461}
{"phase":5,"indexCache":"on","opsPerSec":9092,"queriesPerSec":8187,"mutationsPerSec":906,"queryP50":0.085,"queryP99":10.871,"mutationP50":20.85,"mutationP99":60.431,"queryCacheHitRate":0.096,"indexCacheHitRate":0.91,"indexCacheMB":7.9,"storeCallsPerOp":0.248,"storeCallsPerSec":2256}
```

## pg-unique

```json
{"KIND":"postgres","SCENARIO":"unique","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":10,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":1,"seedMs":6084}
{"phase":1,"indexCache":"off","opsPerSec":2021,"queriesPerSec":1822,"mutationsPerSec":200,"queryP50":12.61,"queryP99":39.878,"mutationP50":29.252,"mutationP99":79.362,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":6064}
{"phase":2,"indexCache":"off","opsPerSec":1970,"queriesPerSec":1771,"mutationsPerSec":199,"queryP50":12.843,"queryP99":36.426,"mutationP50":29.724,"mutationP99":111.828,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":5910}
{"phase":3,"indexCache":"on","opsPerSec":8779,"queriesPerSec":7898,"mutationsPerSec":881,"queryP50":0.09,"queryP99":12.855,"mutationP50":21.255,"mutationP99":64.446,"queryCacheHitRate":0,"indexCacheHitRate":0.915,"indexCacheMB":7.9,"storeCallsPerOp":0.254,"storeCallsPerSec":2234}
{"phase":4,"indexCache":"off","opsPerSec":1988,"queriesPerSec":1787,"mutationsPerSec":200,"queryP50":12.748,"queryP99":47.217,"mutationP50":29.076,"mutationP99":76.238,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":5963}
{"phase":5,"indexCache":"on","opsPerSec":8284,"queriesPerSec":7464,"mutationsPerSec":820,"queryP50":0.099,"queryP99":13.115,"mutationP50":22.65,"mutationP99":61.074,"queryCacheHitRate":0,"indexCacheHitRate":0.914,"indexCacheMB":7.8,"storeCallsPerOp":0.258,"storeCallsPerSec":2138}
```

## pg-w50

```json
{"KIND":"postgres","SCENARIO":"mixed","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":50,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":1,"seedMs":5399}
{"phase":1,"indexCache":"off","opsPerSec":2408,"queriesPerSec":1191,"mutationsPerSec":1217,"queryP50":6.578,"queryP99":17.721,"mutationP50":18.773,"mutationP99":35.431,"queryCacheHitRate":0.017,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.975,"storeCallsPerSec":7165}
{"phase":2,"indexCache":"off","opsPerSec":2407,"queriesPerSec":1202,"mutationsPerSec":1205,"queryP50":6.504,"queryP99":18.386,"mutationP50":18.675,"mutationP99":40.082,"queryCacheHitRate":0.016,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.976,"storeCallsPerSec":7166}
{"phase":3,"indexCache":"on","opsPerSec":5309,"queriesPerSec":2663,"mutationsPerSec":2647,"queryP50":1.525,"queryP99":6.105,"mutationP50":9.734,"mutationP99":27.95,"queryCacheHitRate":0.015,"indexCacheHitRate":0.856,"indexCacheMB":7.6,"storeCallsPerOp":0.428,"storeCallsPerSec":2274}
{"phase":4,"indexCache":"off","opsPerSec":2323,"queriesPerSec":1157,"mutationsPerSec":1166,"queryP50":6.716,"queryP99":23.974,"mutationP50":18.706,"mutationP99":52.315,"queryCacheHitRate":0.015,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.977,"storeCallsPerSec":6915}
{"phase":5,"indexCache":"on","opsPerSec":5028,"queriesPerSec":2477,"mutationsPerSec":2551,"queryP50":1.583,"queryP99":7.747,"mutationP50":9.913,"mutationP99":33.34,"queryCacheHitRate":0.015,"indexCacheHitRate":0.855,"indexCacheMB":7.6,"storeCallsPerOp":0.432,"storeCallsPerSec":2170}
```

## pg-worst

```json
{"KIND":"postgres","SCENARIO":"mixed","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":90,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":0,"seedMs":4418}
{"phase":1,"indexCache":"off","opsPerSec":2397,"queriesPerSec":236,"mutationsPerSec":2161,"queryP50":5.595,"queryP99":18.06,"mutationP50":13.031,"mutationP99":30.487,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":7191}
{"phase":2,"indexCache":"off","opsPerSec":2370,"queriesPerSec":233,"mutationsPerSec":2137,"queryP50":5.719,"queryP99":21.24,"mutationP50":13.264,"mutationP99":35.216,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":7111}
{"phase":3,"indexCache":"on","opsPerSec":3054,"queriesPerSec":305,"mutationsPerSec":2750,"queryP50":3.694,"queryP99":17.216,"mutationP50":10.514,"mutationP99":28.211,"queryCacheHitRate":0,"indexCacheHitRate":0.371,"indexCacheMB":0,"storeCallsPerOp":1.886,"storeCallsPerSec":5762}
{"phase":4,"indexCache":"off","opsPerSec":2367,"queriesPerSec":235,"mutationsPerSec":2132,"queryP50":5.661,"queryP99":20.718,"mutationP50":13.314,"mutationP99":32.714,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":7101}
{"phase":5,"indexCache":"on","opsPerSec":2749,"queriesPerSec":279,"mutationsPerSec":2470,"queryP50":3.845,"queryP99":21.417,"mutationP50":11.118,"mutationP99":37.462,"queryCacheHitRate":0,"indexCacheHitRate":0.371,"indexCacheMB":0,"storeCallsPerOp":1.886,"storeCallsPerSec":5184}
```

## sqlite-mixed

```json
{"KIND":"sqlite","SCENARIO":"mixed","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":10,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":1,"seedMs":1129}
{"phase":1,"indexCache":"off","opsPerSec":7757,"queriesPerSec":6989,"mutationsPerSec":768,"queryP50":2.09,"queryP99":5.156,"mutationP50":21.329,"mutationP99":52.546,"queryCacheHitRate":0.101,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.727,"storeCallsPerSec":21151}
{"phase":2,"indexCache":"off","opsPerSec":7181,"queriesPerSec":6476,"mutationsPerSec":704,"queryP50":2.286,"queryP99":8.077,"mutationP50":22.52,"mutationP99":63.209,"queryCacheHitRate":0.105,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.716,"storeCallsPerSec":19505}
{"phase":3,"indexCache":"on","opsPerSec":11725,"queriesPerSec":10531,"mutationsPerSec":1194,"queryP50":1.172,"queryP99":7.492,"mutationP50":12.723,"mutationP99":37.332,"queryCacheHitRate":0.102,"indexCacheHitRate":0.933,"indexCacheMB":8,"storeCallsPerOp":0.181,"storeCallsPerSec":2125}
{"phase":4,"indexCache":"off","opsPerSec":6259,"queriesPerSec":5628,"mutationsPerSec":631,"queryP50":2.612,"queryP99":13.142,"mutationP50":25.108,"mutationP99":64.345,"queryCacheHitRate":0.103,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.723,"storeCallsPerSec":17043}
{"phase":5,"indexCache":"on","opsPerSec":11035,"queriesPerSec":9915,"mutationsPerSec":1120,"queryP50":1.232,"queryP99":10.34,"mutationP50":13.321,"mutationP99":40.376,"queryCacheHitRate":0.105,"indexCacheHitRate":0.931,"indexCacheMB":8,"storeCallsPerOp":0.187,"storeCallsPerSec":2065}
```

## memory-mixed

```json
{"KIND":"memory","SCENARIO":"mixed","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":10,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":1,"seedMs":706}
{"phase":1,"indexCache":"off","opsPerSec":16323,"queriesPerSec":14707,"mutationsPerSec":1616,"queryP50":0.905,"queryP99":4.514,"mutationP50":9.823,"mutationP99":28.468,"queryCacheHitRate":0.109,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.707,"storeCallsPerSec":44179}
{"phase":2,"indexCache":"off","opsPerSec":13761,"queriesPerSec":12394,"mutationsPerSec":1368,"queryP50":1.102,"queryP99":5.372,"mutationP50":11.494,"mutationP99":33.352,"queryCacheHitRate":0.105,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.717,"storeCallsPerSec":37391}
{"phase":3,"indexCache":"on","opsPerSec":13087,"queriesPerSec":11806,"mutationsPerSec":1281,"queryP50":1.077,"queryP99":5.785,"mutationP50":11.708,"mutationP99":41.38,"queryCacheHitRate":0.108,"indexCacheHitRate":0.937,"indexCacheMB":8.1,"storeCallsPerOp":0.171,"storeCallsPerSec":2234}
{"phase":4,"indexCache":"off","opsPerSec":12585,"queriesPerSec":11315,"mutationsPerSec":1269,"queryP50":1.176,"queryP99":5.604,"mutationP50":12.217,"mutationP99":42.432,"queryCacheHitRate":0.105,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.717,"storeCallsPerSec":34189}
{"phase":5,"indexCache":"on","opsPerSec":12949,"queriesPerSec":11648,"mutationsPerSec":1301,"queryP50":1.09,"queryP99":4.8,"mutationP50":12.109,"mutationP99":38.468,"queryCacheHitRate":0.104,"indexCacheHitRate":0.936,"indexCacheMB":8,"storeCallsPerOp":0.174,"storeCallsPerSec":2252}
```

## mem-worst

```json
{"KIND":"memory","SCENARIO":"mixed","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":90,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":0,"seedMs":703}
{"phase":1,"indexCache":"off","opsPerSec":24255,"queriesPerSec":2428,"mutationsPerSec":21827,"queryP50":0.758,"queryP99":2.009,"mutationP50":1.236,"mutationP99":4.801,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":72765}
{"phase":2,"indexCache":"off","opsPerSec":22122,"queriesPerSec":2212,"mutationsPerSec":19910,"queryP50":0.788,"queryP99":2.538,"mutationP50":1.315,"mutationP99":5.669,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":66367}
{"phase":3,"indexCache":"on","opsPerSec":18915,"queriesPerSec":1901,"mutationsPerSec":17014,"queryP50":0.87,"queryP99":3.992,"mutationP50":1.49,"mutationP99":8.246,"queryCacheHitRate":0,"indexCacheHitRate":0.369,"indexCacheMB":0,"storeCallsPerOp":1.892,"storeCallsPerSec":35783}
{"phase":4,"indexCache":"off","opsPerSec":17468,"queriesPerSec":1737,"mutationsPerSec":15731,"queryP50":0.939,"queryP99":2.869,"mutationP50":1.589,"mutationP99":11.068,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":52403}
{"phase":5,"indexCache":"on","opsPerSec":12644,"queriesPerSec":1265,"mutationsPerSec":11379,"queryP50":1.153,"queryP99":6.553,"mutationP50":1.928,"mutationP99":13.985,"queryCacheHitRate":0,"indexCacheHitRate":0.37,"indexCacheMB":0,"storeCallsPerOp":1.891,"storeCallsPerSec":23911}
```

# As built (the same bench on the implementation, 2026-10-06)

## pg-mixed (as built)

```json
{"KIND":"postgres","SCENARIO":"mixed","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":10,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":1,"seedMs":5475}
{"phase":1,"indexCache":"off","opsPerSec":2330,"queriesPerSec":2099,"mutationsPerSec":230,"queryP50":11.878,"queryP99":25.609,"mutationP50":28.601,"mutationP99":54.027,"queryCacheHitRate":0.079,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.788,"storeCallsPerSec":6494}
{"phase":2,"indexCache":"off","opsPerSec":2396,"queriesPerSec":2151,"mutationsPerSec":245,"queryP50":11.679,"queryP99":25.558,"mutationP50":27.214,"mutationP99":50.784,"queryCacheHitRate":0.077,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.794,"storeCallsPerSec":6695}
{"phase":3,"indexCache":"on","opsPerSec":10111,"queriesPerSec":9118,"mutationsPerSec":994,"queryP50":0.076,"queryP99":10.359,"mutationP50":19.122,"mutationP99":58.232,"queryCacheHitRate":0.097,"indexCacheHitRate":0.913,"indexCacheMB":15.8,"storeCallsPerOp":0.238,"storeCallsPerSec":2410}
{"phase":4,"indexCache":"off","opsPerSec":2323,"queriesPerSec":2095,"mutationsPerSec":228,"queryP50":11.938,"queryP99":35.502,"mutationP50":27.325,"mutationP99":55.043,"queryCacheHitRate":0.079,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.785,"storeCallsPerSec":6469}
{"phase":5,"indexCache":"on","opsPerSec":9435,"queriesPerSec":8493,"mutationsPerSec":942,"queryP50":0.081,"queryP99":10.419,"mutationP50":19.766,"mutationP99":77.229,"queryCacheHitRate":0.095,"indexCacheHitRate":0.911,"indexCacheMB":15.7,"storeCallsPerOp":0.245,"storeCallsPerSec":2311}
```

## pg-unique (as built)

```json
{"KIND":"postgres","SCENARIO":"unique","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":10,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":1,"seedMs":5008}
{"phase":1,"indexCache":"off","opsPerSec":2266,"queriesPerSec":2049,"mutationsPerSec":218,"queryP50":11.767,"queryP99":25.655,"mutationP50":27.616,"mutationP99":81.469,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":6799}
{"phase":2,"indexCache":"off","opsPerSec":2228,"queriesPerSec":2002,"mutationsPerSec":226,"queryP50":12.087,"queryP99":25.86,"mutationP50":27.238,"mutationP99":49.85,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":6684}
{"phase":3,"indexCache":"on","opsPerSec":9444,"queriesPerSec":8490,"mutationsPerSec":954,"queryP50":0.091,"queryP99":11.4,"mutationP50":19.651,"mutationP99":55.415,"queryCacheHitRate":0,"indexCacheHitRate":0.917,"indexCacheMB":15.7,"storeCallsPerOp":0.249,"storeCallsPerSec":2349}
{"phase":4,"indexCache":"off","opsPerSec":2160,"queriesPerSec":1942,"mutationsPerSec":218,"queryP50":12.244,"queryP99":35.552,"mutationP50":27.039,"mutationP99":59.839,"queryCacheHitRate":0,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":3,"storeCallsPerSec":6481}
{"phase":5,"indexCache":"on","opsPerSec":8615,"queriesPerSec":7751,"mutationsPerSec":865,"queryP50":0.093,"queryP99":11.616,"mutationP50":21.38,"mutationP99":59.613,"queryCacheHitRate":0,"indexCacheHitRate":0.914,"indexCacheMB":15.6,"storeCallsPerOp":0.257,"storeCallsPerSec":2212}
```

## pg-w50 (as built)

```json
{"KIND":"postgres","SCENARIO":"mixed","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":50,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":1,"seedMs":5164}
{"phase":1,"indexCache":"off","opsPerSec":2544,"queriesPerSec":1271,"mutationsPerSec":1273,"queryP50":6.284,"queryP99":17.726,"mutationP50":17.526,"mutationP99":35.493,"queryCacheHitRate":0.015,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.977,"storeCallsPerSec":7573}
{"phase":2,"indexCache":"off","opsPerSec":2349,"queriesPerSec":1169,"mutationsPerSec":1180,"queryP50":6.617,"queryP99":20.31,"mutationP50":18.579,"mutationP99":39.09,"queryCacheHitRate":0.016,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.976,"storeCallsPerSec":6990}
{"phase":3,"indexCache":"on","opsPerSec":5243,"queriesPerSec":2622,"mutationsPerSec":2621,"queryP50":1.541,"queryP99":6.775,"mutationP50":9.583,"mutationP99":29.727,"queryCacheHitRate":0.016,"indexCacheHitRate":0.856,"indexCacheMB":15.1,"storeCallsPerOp":0.428,"storeCallsPerSec":2244}
{"phase":4,"indexCache":"off","opsPerSec":2336,"queriesPerSec":1164,"mutationsPerSec":1172,"queryP50":6.706,"queryP99":25.399,"mutationP50":18.718,"mutationP99":42.709,"queryCacheHitRate":0.016,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.977,"storeCallsPerSec":6953}
{"phase":5,"indexCache":"on","opsPerSec":5182,"queriesPerSec":2577,"mutationsPerSec":2605,"queryP50":1.577,"queryP99":6.543,"mutationP50":9.653,"mutationP99":37.872,"queryCacheHitRate":0.018,"indexCacheHitRate":0.856,"indexCacheMB":15,"storeCallsPerOp":0.429,"storeCallsPerSec":2222}
```

## sqlite-mixed (as built)

```json
{"KIND":"sqlite","SCENARIO":"mixed","CHANNELS":1000,"MSGS":50,"USERS":10000,"WRITE_PCT":10,"CONC":32,"SECS":10,"ROUNDS":2,"SKEW":1,"seedMs":1076}
{"phase":1,"indexCache":"off","opsPerSec":8058,"queriesPerSec":7245,"mutationsPerSec":814,"queryP50":2.015,"queryP99":5.029,"mutationP50":20.011,"mutationP99":49.326,"queryCacheHitRate":0.102,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.724,"storeCallsPerSec":21951}
{"phase":2,"indexCache":"off","opsPerSec":7399,"queriesPerSec":6659,"mutationsPerSec":740,"queryP50":2.188,"queryP99":9.451,"mutationP50":21.244,"mutationP99":55.072,"queryCacheHitRate":0.101,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.727,"storeCallsPerSec":20180}
{"phase":3,"indexCache":"on","opsPerSec":11945,"queriesPerSec":10765,"mutationsPerSec":1180,"queryP50":1.149,"queryP99":7.344,"mutationP50":12.52,"mutationP99":40.344,"queryCacheHitRate":0.104,"indexCacheHitRate":0.934,"indexCacheMB":15.9,"storeCallsPerOp":0.179,"storeCallsPerSec":2136}
{"phase":4,"indexCache":"off","opsPerSec":6581,"queriesPerSec":5916,"mutationsPerSec":665,"queryP50":2.414,"queryP99":14.041,"mutationP50":23.555,"mutationP99":66.099,"queryCacheHitRate":0.101,"indexCacheHitRate":0,"indexCacheMB":0,"storeCallsPerOp":2.728,"storeCallsPerSec":17950}
{"phase":5,"indexCache":"on","opsPerSec":11720,"queriesPerSec":10551,"mutationsPerSec":1170,"queryP50":1.158,"queryP99":6.658,"mutationP50":12.787,"mutationP99":41.669,"queryCacheHitRate":0.103,"indexCacheHitRate":0.933,"indexCacheMB":15.9,"storeCallsPerOp":0.181,"storeCallsPerSec":2122}
```
