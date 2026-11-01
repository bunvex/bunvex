---
"@bunvex/server": patch
---

A push's code goes live all at once: the app's and every component's functions, routers and HTTP routing are swapped in one step once all of them are loaded, so a function run during a push sees all of the old code or all of the new. Before, a query run while a push installed could run the new app's code with an old component's. A cron the push adds waits for the code it names.
