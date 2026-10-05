---
"@bunvex/values": minor
"@bunvex/server": minor
"@bunvex/core": patch
---

Values nest at most 64 levels, as Convex's (`MAX_NESTING`): a function's arguments 63 (Convex parses `[args]`), its result 64, a written value 64 (a patch: each field). Past it the call fails with Convex's message, ``Invalid arguments for m.js:fn: Value is too nested (nested 65 levels deep > maximum nesting 64)``, ``Function m.js:fn return value invalid: …`` or ``Invalid argument `value` for `db.insert`: …``, in Convex's order (nesting, then size, then validator; a written value before its table and document). A value of any depth fails with the message instead of overflowing the stack (DV-363). `@bunvex/values` exports `MAX_VALUE_NESTING`, `TOO_NESTED_MESSAGE` and `measureRawValue` (size and nesting in one walk); `fromJsonValue` and `copyValue` refuse a value past the limit (STUDY-109).
