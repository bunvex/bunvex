---
"@bunvex/server": minor
"@bunvex/cli": minor
---

`bunvex run --inline-query '<js>'` evaluates a readonly query on the deployment, as Convex's: an expression is returned, statements are kept, a module whose default export is a query is sent as is (its builders from `bunvex:/_system/repl/wrappers.js`). The server gains Convex's function tester, `POST /api/run_test_function`: the module analyzed alone, its default query run once, uncached, logged with the `Tester` caller (STUDY-119).
