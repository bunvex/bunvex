---
"@bunvex/auth": minor
---

`@bunvex/auth` adds the sign-in methods' components: `authPassword` (passwords hashed with argon2id off the JavaScript thread, at least 10 characters for a new one through the method and at most 100, the most frequent passwords refused, checks rate limited per user) and `authUsername` (one unique username per user, up to 100 characters, case and Unicode normalization ignored). Each mounts from `@bunvex/auth/components/<name>/bunvex.config.js`, and `@bunvex/auth/components/<name>/test` mounts it in a `@bunvex/testing` deployment.
