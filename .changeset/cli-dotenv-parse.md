---
"@bunvex/cli": patch
---

`.env`, `.env.local` and `bunvex env set --from-file` / stdin are read as dotenv reads them, as Convex's CLI does: multi-line quoted values, `\n` expanded in double quotes, an unquoted `#` starting a comment, backtick quotes, `.` and `-` in names, `KEY: value`. What `bunvex env list` prints now reads back unchanged; before, a multi-line value (a PEM key) was cut to its first line with a stray quote.
