---
"@bunvex/core": patch
---

A filter's errors name a value's type as Convex's backend does (STUDY-161 §14): `(type Float64)`, `(type Bytes)`, `(type Null)`, … instead of `float64`, `bytes`, `null`.
