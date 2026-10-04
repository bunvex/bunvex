---
"@bunvex/cli": patch
---

`bunvex dev` writes `.env.local` and `.gitignore` as Convex's CLI does. Each variable it adds comes after a blank line, and an unchanged file is not rewritten. A variable already set, even as `export NAME=…`, is updated in place or left alone, never written twice. `.env.local` is added to `.gitignore` unless a line already covers it: `.env.local`, `.env.*`, `.env*`, `.env*.local` or any line ending in `.local`. It is added after a line break.
