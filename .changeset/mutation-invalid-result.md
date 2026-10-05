---
"@bunvex/server": patch
---

A mutation whose result is not a value (`undefined` inside an array, a function, a symbol, a class instance such as a `Date`) now fails as a whole, as in Convex: the result is converted inside the run, so none of its writes commit. Before, the writes committed and only the response failed. A nested `ctx.runMutation` that fails this way rolls back its own writes; the caller may catch the error and go on. Found by the differential tests (STUDY-129).
