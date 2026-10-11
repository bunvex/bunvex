---
"@bunvex/cli": minor
---

`bunvex dev` and `bunvex deploy` now tell you when npm has a newer `bunvex` (AD-29, STUDY-146 §7). They print one line, from a check that runs beside the command. It never holds the command up: the check has a 1.5 s timeout, asks the registry at most once a day (the answer is cached), and fails silently. It is off when `CI`, `BUNVEX_DISABLE_VERSION_CHECK` or `NO_UPDATE_NOTIFIER` is set, and `BUNVEX_VERSION_API_ORIGIN` points it at another registry.
