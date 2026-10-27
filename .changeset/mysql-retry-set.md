---
"@bunvex/persistence": patch
---

MySQL errors are retried as Convex's now classifies them: of the IO errors, only a refused or reset connection, an unexpected end and a temporary DNS failure (`EAI_AGAIN`) count as a lost connection. A broken pipe, a timeout, or an unreachable host or network is no longer retried.
