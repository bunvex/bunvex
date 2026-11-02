---
"@bunvex/server": minor
"@bunvex/sandbox": patch
---

`@bunvex/server/password`'s `hashPassword(password, salt)` and `verifyPassword(password, hash)` hash and verify passwords with argon2id (16 MiB, 3 passes, 1 lane; PHC strings) on Bun's native argon2, off the JavaScript thread, also under the function sandbox. Only the mutations of the `authPassword` component may call them; any other function gets an error. A stored hash asking for more than 64 MiB or 10 passes is refused.
