---
"@bunvex/values": patch
---

Floats in messages print as Convex prints them (Rust's `{:?}`): `1e16`, `5e-5`, `1.5e-7`, and an exact tie between two shortest candidates resolved upwards. The export's lossless JSON writes a positive exponent with a `+` (`1e+21`), as Convex's serde_json 1.0.151 does. Both are checked against Rust itself.
