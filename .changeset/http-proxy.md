---
"@bunvex/server": minor
"bunvex": minor
---

The SSRF proxy, as Convex's `--convex-http-proxy`: `bunvex-local-backend --http-proxy <url>` (or `createServer({ httpProxy })` / `BUNVEX_HTTP_PROXY`) sends actions' `fetch`, auth providers' discovery and JWKS, and the webhook, Datadog, Axiom and PostHog log streams through a screening proxy, each request named by the instance (`Proxy-Authorization`). A 407 refuses a request with Convex's `Request to <url> forbidden`. Without a proxy the backend warns at start, as Convex's.
