---
"@bunvex/cli": patch
---

`bunvex.json` is checked with Convex's messages. A file that is not an object prints "Expected `bunvex.json` to contain an object" (a `null` file used to throw a `TypeError`). A field of the wrong type names its path, e.g. "`functions` in `bunvex.json`: Expected string, received number". JSON that does not parse prints `Parsing "bunvex.json" failed` and the parse error.
