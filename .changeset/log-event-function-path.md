---
"@bunvex/server": patch
---

Log stream events name a function as Convex's do: `function.path` is the stripped path (`messages:send`, a default export's module alone), no longer `messages.js:send`, in `console`, `function_execution` and exception events and in the Sentry and PostHog payloads built from them. A nested call's console line keeps its canonical path, as on Convex. `function.cached` is `false` on an action's streamed console lines, as on Convex, where it was `null`.
