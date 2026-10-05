# STUDY-112 — Health routes: `/instance_version`, `/`, `/echo` and the version string

- **Status:** implemented; V1–V3 decided by the owner (2026-10-05), DV-373–DV-375; V3's premise is open (§6)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05; behaviour probed on a
  local `convex-local-backend` build (a dev build: its version is `unknown`)
- **Related:** STUDY-34 (`/instance_name`, the admin API), STUDY-31 H5 (DV-147, the site's `/version`), STUDY-67
  H2 (CORS)

## 1. How Convex does it

**The routes.** `crates/local_backend/src/router.rs:543-566` `health_check_routes(version)` is merged into the
API router (`router.rs:428`) and has its own `cors()` layer (`router.rs:620-634`):

| Route | Answer |
|---|---|
| `GET /instance_name` | the instance name, plain text (bunvex has it since STUDY-34) |
| `GET /instance_version` | `version`, which is `SERVER_VERSION_STR` (`router.rs:424`) |
| `GET /` | `This Convex deployment is running. See https://docs.convex.dev/.` |
| `POST /echo` | the request body, as a stream (`axum::body::Body` in, the same `Body` out) |

No route takes auth. Each is a single-method axum route: another method is a 405 with `allow` (`GET,HEAD` for
the `get` routes, `POST` for `/echo`; probed). A string answer is `text/plain; charset=utf-8`; `/echo`'s answer
has no content type of its own (probed: a request's `content-type: application/json` is not echoed back).

**The version.** `crates/metrics/src/lib.rs:51-77`: `SERVER_VERSION_STR` is the release version baked in at
compile time (`CONVEX_RELEASE_VERSION`), or `CONVEX_RELEASE_VERSION_DEV` at run time, or `unknown` (a dev
build, or the value `dev`). The meta route `GET /version` (`crates/common/src/http/mod.rs:568-573`, added by
`ConvexHttpService` to every service) answers the version the service was built with: the backend passes
`SERVER_VERSION_STR` (`local_backend/src/main.rs:174-177`), so `/version` and `/instance_version` agree. The
site proxy is a second `ConvexHttpService` built with `"unknown"` (`local_backend/src/proxy.rs:59-62`), so its
`/version` is always `unknown`. `crates/health_check` polls `/instance_version` to wait for a backend at an
expected version; `is_high_volume_path` (`common/src/http/mod.rs:1188`) keeps it out of the request logs.

**`/echo` and its limit.** `npx convex network-test` (`npm-packages/convex/src/cli/lib/networkTest.ts:46-52,
272-310`) POSTs 128 B, 4 MiB and (optionally) 64 MiB of random bytes and checks they come back equal, timing
the round trip. The route is `post(|body: Body| async move { body })` with `.layer(DefaultBodyLimit::max(
*MAX_ECHO_BYTES))`, `MAX_ECHO_BYTES` = 128 MiB (`crates/common/src/knobs.rs:1745-1748`, env `MAX_ECHO_BYTES`),
commented "Limit requests to 128MiB to help mitigate DDoS attacks."

**But the limit is not enforced.** Axum's `DefaultBodyLimit` is only read by extractors that buffer through
`Bytes` (`Bytes`, `String`, `Json`, `Form`, …): axum-core 0.5's `impl FromRequest for Body` is
`Ok(req.into_body())`, while `Bytes`' calls `req.into_limited_body()`; axum's docs say a handler that consumes
the body directly does not get the limit. No `RequestBodyLimitLayer` wraps the service either (the only body
limits in `crates/` are the `DefaultBodyLimit` layers). Probed on a local backend: a 4 MiB, 128 MiB,
128 MiB + 1 and 200 MiB body (declared length) and a 130 MiB chunked body all came back **200 with every byte**.
Convex Cloud's proxy (Usher, `crates_private`, not open source) may enforce it: the comment above
`streaming_import_routes` says route limits are mirrored there.

## 2. What an app can observe

- `GET /instance_version` and `GET /version`: plain text, the server's version; the same string on both.
- `GET /`: 200 and a sentence saying the deployment runs.
- `POST /echo`: the bytes back unchanged; `network-test`'s 128 B / 4 MiB / 64 MiB rounds must pass.
- No auth; CORS headers (origin mirrored, credentials) on `/instance_name`, `/instance_version`, `/` and
  `/echo`, a preflight answered; none on the meta `/version`.
- 405 with `allow` for another method.

## 3. How bunvex does it

`packages/server/src/health.ts` (new) holds the routes; `server.ts` asks it first on the API port, before the
request body cap (the API server runs Bun with `maxRequestBodySize` = `Number.MAX_SAFE_INTEGER` and caps bodies
itself, H3), and the site port asks `versionRoute` for `/version`.

- **Version (V1, DV-373).** `SERVER_VERSION` is `@bunvex/server`'s `package.json` version (imported; the
  standalone binary bundles it). `/version` (API and site port) and `/instance_version` answer it. Before, both
  `/version`s answered `bunvex`. Nothing compared that text: docker-compose's healthcheck is `curl -f /version`
  and `scripts/mac-bench.sh` waits on `curl -fs /version`, both on the status only; `bunvex dev`'s local backend
  waits on `/instance_name`. The one test that read `bunvex` (`http-actions.test.ts`, site `/version`) now
  expects the package version.
- **`/` (V2, DV-374).** `This bunvex deployment is running.`: no Convex wording or link (rule 5).
- **`/echo` (V3, DV-375).** The body streams back as it arrives (no buffering, no copy). A declared length over
  128 MiB is a 413 `Payload Too Large` before a byte is read. A body without a length is counted as it streams
  and cut off past 128 MiB: the 200 has already gone out, so the client sees the connection break (an echo can
  only answer 413 up front by buffering the body first).
- **Methods.** A shared `getOnly` answers GET and HEAD and 405s the rest with `allow: GET,HEAD` (also
  `/instance_name` and `/version`, which answered any method before); `/echo` 405s all but POST with
  `allow: POST`.
- **CORS.** `cors.ts`' `hasApiCors` now lists the four health routes; the meta `/version` stays without.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| V1 | `/version` and `/instance_version` answer `@bunvex/server`'s semver (`0.1.0-alpha.0`), and the site's `/version` too | Convex answers its release version (`unknown` on a dev build), and the site proxy always `unknown`; bunvex's release version is its package's | owner, 2026-10-05: DV-373 (also updates DV-147) |
| V2 | `GET /` answers `This bunvex deployment is running.` | Convex's sentence names Convex and links docs.convex.dev (rule 5) | owner, 2026-10-05: DV-374 |
| V3 | `/echo` enforces 128 MiB: 413 for a declared length past it, a broken connection for a longer chunked body | Convex declares the 128 MiB limit (knob, comment) but its `Body` extractor never applies it: its open-source backend echoes any size (probed). The owner asked for the limit and the 413, as Convex intends | owner, 2026-10-05: DV-375 — the premise ("Convex returns 413") is not what the open-source code does; confirmation asked (§6) |

## 5. Tests

`packages/server/test/health-routes.test.ts`:

- the version routes (API `/version`, `/instance_version`, site `/version`) equal `package.json`'s version;
- `GET /` answers the sentence, which does not contain "convex";
- no auth: a bad `Authorization` header changes nothing;
- methods: POST to each GET route is 405 `GET,HEAD`, HEAD is 200; GET `/echo` is 405 `POST`;
- CORS on `/`, `/instance_version`, `/instance_name`, `/echo` and a preflight on `/echo`; none on `/version`;
- a 4 MiB random round trip, byte for byte, with no content type; an empty body;
- a raw socket declaring 128 MiB + 1 gets `413` after 1 KiB of body (nothing near 128 MiB is allocated); one
  declaring exactly 128 MiB gets `200` (the echo starts streaming before the body ends);
- a chunked 3 MB body comes back whole; a chunked 128 MiB + 1 body (one reused 1 MiB chunk, from a child
  process) breaks off.

`http-actions.test.ts` and `cors.test.ts` still pass with the new version string and CORS paths.

**Sabotage** (each alone, restored after; `git diff` clean):

| Sabotage | Caught by |
|---|---|
| `SERVER_VERSION = "bunvex"` | version routes; no auth |
| site `/version` back to `new Response("bunvex")` | version routes |
| declared-length check `> 2 * MAX_ECHO_BYTES` | the 413 test |
| declared-length check `>=` instead of `>` | the 413 test (exactly 128 MiB is a 413) |
| streamed cut-off at `2 * MAX_ECHO_BYTES` | the chunked cut-off test |
| `/echo` dropped from the CORS paths | the CORS test |
| GET routes accept any method but OPTIONS | the methods test |
| `/echo` accepts GET | the methods test |

No measurement: the routes are new and off every hot path (the API port's dispatch gains one `switch` on the
path before the existing checks).

## 6. Open questions

- **V3's premise.** The owner decided "`/echo` matches Convex, including the 128 MiB limit and the 413". Convex's
  open-source backend does not enforce that limit (§1, probed). Built as decided (limit + 413); the owner may
  instead want no limit (Convex's actual open-source behaviour). `network-test` sends at most 64 MiB, so either
  choice passes it.
