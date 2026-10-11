# STUDY-146 — `bunvex network-test`, `docs`, `update` and `dashboard`

- **Status:** implemented; DV-461 decided (rule 5); one question for the owner (§6)
- **Convex source read:** commit `4577b903` of get-convex/convex-backend (`npm-packages/convex/src/cli/`)
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md) and [STUDY-40](STUDY-40-local-backend-and-local-deployments.md)
  (choosing the deployment), [STUDY-112](STUDY-112-health-routes.md) (`/echo`, `/version`, `/instance_name`),
  [STUDY-124](STUDY-124-cli-output-like-convex.md) (argument errors), DV-202 (no local dashboard), DV-226 (the CLI's
  URL query)

The platform row "`dashboard`, `docs`, `update`, `network-test`" (§12, CLI).

## 1. How Convex does it

### 1.1 `network-test`

`network_test.ts` (a hidden command, `program.ts:59`) and `lib/networkTest.ts`:

- **Options:** `--timeout <timeout>` (seconds, default 30, `Number.parseFloat`), `--ip-family <ipFamily>`
  (`ipv4`, `ipv6` or `auto`), `--speed-test`, and the deployment selection. `--url` with `--admin-key` tests that
  deployment; `--url` alone tests the URL with no admin key; otherwise the configured deployment is used.
  `--prod`, `--preview-name`, `--deployment-name` and `--deployment` are cloud-only.
- It prints `✔ Deployment URL: <url>`, then runs `runNetworkTestOnUrl` (`:25`) inside `withTimeout` (`:316`). On
  timeout it prints "FAIL: Network test timed out after <duration>.".
- **The checks, in order.** Each prints `✔ OK: …` with its duration (`formatDuration`). A failure is a
  `ctx.crash`, printed as `✖ FAIL: …`, with exit 1.
  1. `checkDns` (`:58`): `dns.lookup` of the hostname, giving "OK: DNS lookup => <address>:<ipv4|ipv6>".
  2. `checkTcp` (`:86`): `net.connect` with `noDelay` and the family. The port is the URL's, else 80 for `http:`
     or 443 for `https:`; an `https:` URL without a port also tries port 80. The name is `TCP`, or `TCP/<family>
     <host>:<port>` when a family is chosen. An `AggregateError` lists its errors.
  3. `checkHttp` (`:148`): `GET /instance_name` must answer 200 ("HTTP check" or "HTTPS check"). For `https:` it
     first tries plain HTTP on port 80 without following redirects, where a 301 passes.
  4. `checkWs` (`:202`): without an admin key, "Skipping WebSocket check because no admin key was provided.".
     Otherwise a client with admin auth subscribes to `_system/cli/convexUrl:cloudUrl`. A string within 10 s is
     "OK: WebSocket connection established."; otherwise "FAIL: Failed to connect to deployment over WebSocket.".
  5. `checkEcho` (`:272`): `POST /echo` of 128 random bytes, then 4 MiB, then 64 MiB with `--speed-test`. The
     same bytes must come back. It prints "OK: echo <size> (<duration>, <size>/s)", or "FAIL: echo <size> (Error:
     Response data mismatch)".
  6. "✔ Network test passed."
- **The HTTP requests** go through `bareDeploymentFetch` (`lib/utils/utils.ts:1320`):
  - They throw on an answer that is not a success (`ThrowingFetchError`: "Error: <status> <statusText>", plus
    `: <code>: <message>` when the body has both).
  - They retry up to 6 times with `retryDelay` (1 ms, then 1 s doubling, plus up to 20%), on a network error or a
    404. The idempotent-method rule never applies here, because it reads the request's `method`, which these GETs
    leave unset.
  - Every retried failure goes to `onError`. For the echo this prints "FAIL: echo <size> (<error>),
    retrying...". From the third attempt on there is also "Retrying request (attempt N/6)...".
- **`formatSize`** uses binary units (`bytes`, `KiB`, …) with one decimal and drops a trailing `.0`.
  **`formatDuration`** uses ns, µs, ms, s or m with at most two decimals in en-US. Its nanoseconds are milliseconds
  times 1e9, a factor of 1000 too many.

### 1.2 `docs`

`docs.ts`: `--no-open` prints "Find Convex docs here: https://docs.convex.dev/?utm_source=convex-cli".
Otherwise it opens that URL with the `open` package and prints "Docs have launched! Check your browser.". A
failure to open is not caught. The lines go to stderr.

### 1.3 `update`

`update.ts` prints "To view the Convex changelog, go to https://news.convex.dev/tag/releases/", then "When you
are ready to upgrade, run the following command:", then "npm install convex@latest", then an empty line, and
exits 0. **It does not ask any registry for the latest version.** Convex's CLI has a separate version check:
`checkVersionAndAiFilesStaleness` (`lib/updates.ts`), run by `dev`, `deploy` and `init`. It asks Convex's own
service (`https://version.convex.dev/v1/version`, `lib/versionApi.ts`) and prints the message the service
returns. That is a Convex-hosted service, not npm.

### 1.4 `dashboard` (`dash`)

`dashboard.ts` takes `--no-open` and the deployment selection, and shows its help after an argument error.

| Deployment | What it does |
|---|---|
| Self-hosted (`deploymentFields === null`) | prints "Self-hosted deployment configured.", "\`npx convex dashboard\` is not supported for self-hosted deployments.", "See self-hosting instructions for how to self-host the dashboard." (yellow, stderr), exit 0; nothing opened |
| Anonymous (local, no account) | the dashboard `dev` runs beside it (`localDeployment/dashboard.ts:130`); with none configured, or none answering `api/current_deployment` for this deployment, the warning "You are not currently running the dashboard locally. Make sure \`npx convex dev\` is running and try again.", exit 0 |
| Cloud (`dev`, `prod`, `preview`, `local` with a project, `custom`) | `https://dashboard.convex.dev/d/<name>`, opened or printed on stdout with `--no-open`; on failure to open, "⚠️ Could not open dashboard in the default browser.\nPlease visit: <url>" |

### 1.5 What applies to a self-hosted deployment

- `network-test`: all of it, except the cloud selection flags.
- `docs` and `update`: all of it (they read no deployment).
- `dashboard`: only the self-hosted message. The cloud dashboard is Convex's service. The anonymous local
  dashboard is the one `dev` runs.

## 2. What an app can observe

Nothing at runtime. These are developer commands. A developer sees their lines, exit codes and timings, the URLs
they open or print, and the requests `network-test` sends (`/instance_name`, a WebSocket subscription, `/echo`).

## 3. How bunvex does it

`packages/cli/src/network-test.ts`, `docs.ts` (with `update`), `dashboard.ts` and `browser.ts`.

- **`network-test`:** Convex's options, checks, order, lines, retries and timeout.
  - The configured deployment comes from `acquireTarget`, as for the other one-off commands. A local deployment
    is started for the test if it is not running (STUDY-40 §2.3; Convex's `assertLocalBackendRunning` fails
    instead).
  - The WebSocket check uses bunvex's client and the CLI's query `_system/cli/deploymentUrl:cloudUrl` (DV-226),
    and closes it afterwards.
  - The server already has `/instance_name` and `/echo` (STUDY-112, `MAX_ECHO_BYTES` 128 MiB), so 64 MiB passes.
  - After a timeout nothing more is printed, though the checks in flight are not cancelled. The CLI exits
    anyway.
- **`docs`:** opens bunvex's site (DV-461) through `Io.open`. That is the platform's opener (`open`,
  `xdg-open`, `cmd /c start`), as the `open` package's default, and tests pass their own. A failure to open is
  `bunvex docs: <error>` with exit 1, since bunvex's commands report errors rather than crash.
- **`update`:** Convex's three lines, with bunvex's changelog and package (DV-461).
- **`dashboard` / `dash`:**
  - A self-hosted deployment gets Convex's message, with exit 0.
  - A local deployment gets Convex's warning for a missing local dashboard. bunvex has none (DV-202), so that is
    always the answer.
  - With no deployment, it prints `NO_DEPLOYMENT` with exit 1, as the other commands.

  Neither case opens a browser, as Convex's. bunvex has its own self-hosted dashboard app (`apps/dashboard`), but
  the CLI does not know its URL, just as Convex's CLI does not know a self-hosted Convex dashboard's.
- **Output:** plain text without colours, as bunvex's other commands. `network-test` is listed in `bunvex --help`
  (Convex hides it), as `typecheck` already is.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| N1 | `docs` opens `https://bunvex.dev/?utm_source=bunvex-cli`, bunvex's site (it is to hold the user docs; the landing for now). `update` points at `packages/bunvex/CHANGELOG.md` on GitHub and `npm install bunvex@latest`. The messages say "bunvex" | Rule 5: Convex's URLs, package and name | DV-461 (decided, rule 5) |
| — | `dashboard` on a local deployment always warns | DV-202 (no local dashboard) | covered by DV-202 |
| — | `network-test` starts a stopped local deployment | bunvex's one-off commands do (STUDY-40) | existing behaviour |
| — | The WebSocket check's query is `_system/cli/deploymentUrl:cloudUrl` | DV-226 | covered |
| — | A network error's text is Bun's `fetch` error, not Node's ("TypeError: fetch failed") | the runtime | not a choice |

## 4b. Additions (beyond Convex)

None built. A registry check in `update` was asked for (§6). Convex's `update` has none, so it would be an
addition.

## 5. Tests

`packages/cli/test/network-test.test.ts`:

- **The whole test against a deployment in the process:** every line in Convex's form, then the self-hosted
  variables, `--ip-family ipv4` (`TCP/ipv4 127.0.0.1:<port>`) and `--speed-test` (64 MiB echoed).
- **`--url` alone:** the WebSocket check is skipped with Convex's line.
- **Failures:**
  - no deployment;
  - nothing listening (`FAIL: TCP connect (…)`);
  - `/instance_name` answering 503, a JSON 500 (`: Busy: try later`) or 201 (`Unexpected status code: 201`);
  - an echo answered with other bytes.
- **A 404 from `/echo`:** retried with Convex's "retrying..." line (three attempts in 1.5 s, by Convex's backoff),
  ended by `--timeout 1.5` ("timed out after 1.5s").
- **A check still running at the timeout** prints nothing afterwards.
- **Argument errors** as commander's, and `formatSize` / `formatDuration` on Convex's cases, its nanoseconds
  included.
- **`docs`:** opens (stubbed), `--no-open`, a failed open, extra arguments.
- **`update`:** its lines, and an unknown option.
- **`dashboard`:**
  - self-hosted through the variables, `--url` / `--admin-key`, `dash` and `--no-open`;
  - local;
  - no deployment, conflicting variables, extra arguments with the help.

The HTTPS path (the port-80 checks) needs a TLS deployment on port 443 and is not tested.

**Sabotage** (each restored, `git diff` clean after):

| Break | Failed |
|---|---|
| the echo's bytes not compared | "failures" |
| a 404 not retried | the retry test |
| lines still printed after the timeout | "a check that ends after the timeout" |
| the WebSocket check subscribes to another query | the full run (fails the WebSocket check after 10 s) |
| `dashboard` ignores a self-hosted deployment | both dashboard tests that use one |
| `docs --no-open` inverted | the docs test |

**Measurement:** none. No hot path changes.

## 6. Open questions

**Q1 — `bunvex update` and the npm registry.** The request for this work asked that `update` check the npm
registry for a newer `bunvex`, "as Convex's does for `convex`".

- **Convex:** `npx convex update` only prints the changelog link and `npm install convex@latest`. It checks
  nothing. The only version check is the nag message `dev` and `deploy` get from Convex's own service
  (`version.convex.dev`).
- **bunvex:** prints the same lines (built).
- **Same or not:** the same.
- **Why:** nothing to decide for parity. A registry check would be an addition: "Ainda não fizemos", by choice.
- **App impact:** none. Only the developer's terminal.
- **Recommendation:** keep `update` as Convex's. If a version check is wanted, add it as an addition (`AD-NN`)
  shaped like Convex's real one. That would be a quiet check of `https://registry.npmjs.org/bunvex/latest`
  during `dev` and `deploy`, printing a line when a newer version exists. It would also need a way to turn it
  off for offline and CI use.
