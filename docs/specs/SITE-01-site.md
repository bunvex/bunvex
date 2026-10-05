# SITE-01 — bunvex.dev

> **v1, 29 Sep 2026.** Adds one workspace, `apps/site`: the public website at `https://bunvex.dev`. Today it
> is a single landing page; it is built so the user documentation (the `apps/docs` that ARCHITECTURE.md
> planned) can later live in the same app under `/docs`. The living map stays in
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## 1. Goals and non-goals

**Goals**

- A landing page that says what bunvex is, shows the evidence (the benchmark against Convex), and is
  honest about the project being pre-alpha.
- One primary action: **star / watch the repository on GitHub**. No forms, no personal data, no backend.
- Static output (prerendered HTML) that any static host can serve.
- A root layout and route tree that can take `/docs/*` later without restructuring.
- The same visual family as the dashboard: built on `@bunvex/ui` (UI-01).

**Non-goals for v1**

- The documentation itself: its content pipeline (MDX or other), search and sidebar get their own spec
  when there are docs to write. v1 shows **Docs** in the header as disabled, labelled *soon*.
- A waitlist or any collection of e-mail addresses.
- Analytics, cookies, i18n (the site is in English, as is everything in the repo).
- Deployment configuration for a specific host. The build produces a directory of static files; choosing
  and configuring the host is a separate step.

## 2. Stack and versions

Pinned with `^` to the latest release on 29 Sep 2026 (`npm view`), Bun 1.4.2 as for the rest of the repo.

| concern | choice | version |
|---|---|---|
| framework | TanStack Start (`@tanstack/react-start`) | 1.168 |
| router | TanStack Router (`@tanstack/react-router`), file-based routes | 1.170 |
| bundler | Vite + `@vitejs/plugin-react` + `@tailwindcss/vite` | 8.3 · 6.1 · 4.3 |
| UI | React 19.3, `@bunvex/ui` (tokens, themes, components) | workspace |
| output | `tanstackStart({ prerender: { enabled: true, crawlLinks: true } })` → static files in `apps/site/dist/client` | — |
| tests | `bun test` + happy-dom + Testing Library + axe-core, as in `packages/ui` | — |

## 3. Workspace

```
apps/site/                      @bunvex/site (private)
├── package.json                dev / build / preview / test scripts
├── vite.config.ts              tanstackStart (prerender) + react + tailwind
├── tsconfig.json
├── public/                     favicon.svg, og.png, robots.txt
├── src/
│   ├── router.tsx              getRouter()
│   ├── routes/
│   │   ├── __root.tsx          <html>, head (meta, OG, canonical), theme script, header + footer
│   │   └── index.tsx           the landing page
│   ├── components/             landing sections (hero, benchmarks, how-it-works, drivers, code, status)
│   ├── content.ts              every number, link and list the page shows, in one place
│   └── app.css                 tailwind + @bunvex/ui/styles.css + site-only utilities
└── test/                       smoke + accessibility tests
```

- **Dependency rule** (`scripts/check-deps.ts`): `"apps/site": ["ui"]`. The site imports no engine, server
  or client package.
- **Root scripts:** `typecheck` adds `tsc -p apps/site`, `test` adds the site's tests, a new
  `build:site` is added to `check` and to CI after `build:dashboard`.
- **Sitemap:** `sitemap.xml` is written by the build (TanStack Start's sitemap option if the version
  supports it, otherwise a small post-build script), with `https://bunvex.dev` as the base.
- **ARCHITECTURE.md:** the planned `apps/docs/` row becomes `apps/site/ — bunvex.dev: landing now, user
  docs later`.

## 4. Visual design

- Tokens, fonts, light / dark themes and components come from `@bunvex/ui`. The theme script is inlined
  in `<head>` by `__root.tsx` (no flash of the wrong theme); `ThemeProvider` and `ThemeToggle` are reused.
- Landing-only pieces (section layout, hero type scale, the benchmark bar visual) live in
  `apps/site/src/components`, not in the design system. Anything that turns out to be general moves to
  `@bunvex/ui` in a later PR.
- The wordmark is the text "bunvex" in the design system's monospace font; there is no logo yet.
- Responsive down to 360 px wide; no horizontal scroll.

## 5. Content

Every claim on the page must have a source in the repository. All numbers, lists and links live in
`src/content.ts` so they can be checked against their sources in one place.

1. **Header** — wordmark · *Docs* (disabled, "soon") · *Benchmarks* (anchor) · *GitHub* · theme toggle.
2. **Hero** — headline *"The reactive backend of Convex, rewritten for Bun."*; a subline naming its own
   database engine, serializable transactions, reactive queries and pluggable persistence; a
   `pre-alpha` badge; CTAs **Star on GitHub** (primary) and **See the benchmarks** (secondary, anchor).
3. **Benchmarks** — from the full report `docs/bench/E2E-VPS-2026-10-05.md` (until 5 Oct 2026: `E2E-VPS-2026-09-29.md`): Convex self-hosted (on
   Postgres 17) vs bunvex on Postgres (the same instance) vs bunvex on SQLite, for cached read, uncached
   indexed read, durable insert, action, and 10 000 subscribers. Caption: same 2-vCPU VPS, same harness,
   which database each ran on, and which direction is better; link to the full report on GitHub. (The
   owner chose SQLite over memory + log and asked for the cached read, 29 Sep 2026.)
4. **How it works** — three cards: reactive queries (a commit re-runs only the subscriptions whose
   read-set it touched), serializable transactions (optimistic, one committer, no lost updates, no false
   conflicts), pluggable persistence.
5. **Drivers** — memory + log, SQLite (built in), Postgres, MySQL, MongoDB; every driver passes the public
   PERSIST-01 conformance suite, so you can write your own.
6. **Code** — a `schema` + `query` + `mutation` example in **Convex's API shape** (`defineSchema`,
   `v.*`, `query({ args, handler })`), labelled *"Target API — Convex-compatible, landing in Phase 1."*
   The current bunvex API differs (`query(async (ctx, args) => …)`, `new Schema()`); the label is what
   keeps the page true.
7. **Status** — what works today (engine, persistence drivers, HTTP API, WebSocket subscriptions); what is
   still to come (client SDK, validation, auth, scheduler, CLI); the roadmap phases of
   `docs/parity/README.md`, with a link to the parity tables.
8. **Footer** — Apache-2.0 · GitHub · *"bunvex is an independent implementation written from scratch. It
   is not affiliated with Convex, Inc."*

**Naming Convex.** The page names Convex as the reference and in the benchmark (the owner approved this
on 29 Sep 2026). It uses no Convex logo, colors, or visual identity.

**SEO.** `<title>`, meta description, canonical `https://bunvex.dev/`, Open Graph and Twitter card tags,
a static `og.png` (1200×630) committed to `public/`, `robots.txt`, `sitemap.xml`.

## 6. Testing and verification

- **Smoke test:** renders the landing route and asserts the hero headline, the GitHub CTA href, the
  benchmark table (every number from `content.ts`), and the not-affiliated notice.
- **Accessibility:** axe-core on the rendered page, in light and dark, with no violations.
- **Build:** `bun run build:site` produces `index.html` with the content prerendered (not an empty
  shell); the test checks the built HTML for the headline.
- **Manual review before commit:** the owner and Claude review the page in a browser via Playwright
  (desktop and 375 px, light and dark) before anything is committed or a PR is opened.
- `bun run check` passes.

## 7. Open questions

None. Decided with the owner on 29 Sep 2026: landing + base for docs; GitHub as the only CTA; static
prerender; same design system; Convex-shaped code with a *target API* label; Convex named in the
benchmark.
