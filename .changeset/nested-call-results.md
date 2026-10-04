---
"@bunvex/server": patch
---

A nested call's result (`ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`) crosses a JSON boundary, as in Convex: the caller gets `null` where the callee returned `undefined`, a copy of the value (changing it changes nothing in the callee), no `undefined` fields, and object fields in sorted order. A result that is not a value (a `Date`, say) fails the call.
