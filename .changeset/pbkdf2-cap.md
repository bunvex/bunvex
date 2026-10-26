---
"@bunvex/server": patch
---

PBKDF2 in queries, mutations and V8 actions is bounded as in Convex's runtime: `crypto.subtle.deriveBits` and `deriveKey` reject with an `OperationError` "too many iterations" when the iterations times the output's bytes (64 at least) pass 150 000 000, and "cannot generate more than 524288 bits" past 64 KiB. A `"use node"` action has no bound, as Node's.
