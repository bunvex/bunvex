---
"@bunvex/server": patch
---

`authPassword`'s verifier reads a stored hash as Convex Auth 2.0.0 does. A string that is not a PHC string throws that release's message (`Failed to verify password against the stored hash: Error: …`). A PHC string that argon2 cannot verify does not match, so the sign-in is `INVALID_CREDENTIALS`, not a server error. That covers a `$scrypt$` row, another algorithm or version, an unknown parameter, a cost out of range, and a missing salt or tag. A missing cost takes argon2's default (`m=19456`, `t=2`, `p=1`), and `data` is the associated data. A version 0x10 hash never matches (DV-585).
