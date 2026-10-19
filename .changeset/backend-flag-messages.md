---
"@bunvex/server": patch
---

`bunvex-local-backend` reports a mistaken command line as Convex's binary does (clap's messages): value names such as `<FUNCTION_SANDBOX>` and `<DENY_ADDRESSES>` (not `<FUNCTION-SANDBOX>`), the possible values, the tips, the usage lines and "For more information, try '--help'." instead of the whole help. `--port` and `--site-proxy-port` are checked as Rust's `u16` (an empty `--port=` is refused, not port 0) and `--interface` as an IPv4 address; a flag given twice is refused; `-p4000`, `--` and `help` / `keygen help` work. What is refused after the flags parse (the instance secret, the origins) is `Error: …` with exit 1, as Convex's; a secret that is not hex is "Couldn't hexdecode key".
