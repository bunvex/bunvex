---
"@bunvex/cli": minor
---

The push's bundler stubs `import "server-only"` to an empty module (installed or not), so shared Next.js code guarded by it deploys, and turns `import m from "./x.wasm"` into a `WebAssembly.Module` of the file's bytes, as Convex's bundler does (STUDY-83).
