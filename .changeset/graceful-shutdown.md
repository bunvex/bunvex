---
"@bunvex/server": patch
---

A shutdown (SIGINT or SIGTERM, or `shutdown()`) now drains HTTP requests before stopping the rest. It stops taking new connections, lets every request in flight finish (a mutation's caller gets its answer), and wakes long polls such as log streams at once. Then it closes the remaining websockets and stops the workers and the store. Before, in-flight requests were reset, which left their outcome unknown to the client.
