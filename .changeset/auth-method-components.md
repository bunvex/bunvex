---
"@bunvex/auth": minor
---

`@bunvex/auth` adds the sign-in methods' components: `authPassword` (passwords hashed with argon2id off the JavaScript thread, 10 to 100 characters, the 3000 most frequent passwords refused, checks rate limited per user) and `authUsername` (one unique username per user, case and Unicode normalization ignored). Each mounts from `@bunvex/auth/components/<name>/bunvex.config.js`, and `@bunvex/auth/components/<name>/test` mounts it in a `@bunvex/testing` deployment.
