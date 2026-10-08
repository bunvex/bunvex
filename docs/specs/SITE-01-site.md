# SITE-01 — bunvex.dev

> **v1, 29 Sep 2026.** Adds one workspace, `apps/site`: the public website at `https://bunvex.dev`. Today it
> is a single landing page; it is built so the user documentation (the `apps/docs` that ARCHITECTURE.md
> planned) can later live in the same app under `/docs`. The living map stays in
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md).
>
> **v2, 8 Oct 2026** (owner, from a prototype reviewed the same day): a redesigned landing page. Dark only,
> in the Bun family of design (dense, terminal-flavoured, code first) with the site's own palette and bundled
> fonts; the primary action becomes **Try an example**; new sections (a live demo, the code of a real example,
> features, databases, coming from Convex with the parity counts, the roadmap with each phase's status). The
> code sample is no longer labelled "target API": the API it shows is built. §1, §4, §5 and §6 are rewritten.

## 1. Goals and non-goals

**Goals**

- A landing page that says what bunvex is, shows the evidence (the benchmark against Convex), and is
  honest about the project being pre-alpha.
- One primary action: **try an example** (the repository's `examples/`), with **Star on GitHub** as the
  secondary one (v2; v1 had the star as the only action). No forms, no personal data, no backend.
- Static output (prerendered HTML) that any static host can serve.
- A root layout and route tree that can take `/docs/*` later without restructuring.
- Built on `@bunvex/ui` (UI-01) for Tailwind and its components, under the site's own palette (§4).

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

v2 (owner, 8 Oct 2026):

- **Dark only.** The theme is fixed in the markup (`<html class="dark">`): no theme script, no toggle, nothing
  stored. The design system's dark tokens are retuned to the site's palette in `app.css`, so its components
  match.
- **Palette:** a warm near-black (`#111015`, bands `#16151b`, surfaces `#1c1b22`), cream text (`#f3ede2`),
  honey as the accent (`#f4c06a`) and violet as the second colour (`#ad9bff`). Text colours pass WCAG AA on
  the page background. It borrows neither Bun's nor Convex's colours, logos or mascots.
- **Type:** Bricolage Grotesque for headings, IBM Plex Sans for text, IBM Plex Mono for code and data. The
  fonts are npm packages (`@fontsource*`) bundled by Vite: the page fetches nothing from a font service.
- **Mark:** a provisional one, a honey square with a violet offset, beside the wordmark "bunvex" in the
  monospace face (and in the favicon). A real logo is a later decision.
- **Motion:** the hero's live demo (two chat tabs kept in sync while the mutation lights up) and the
  benchmark bars growing in. Both respect `prefers-reduced-motion`; the demo starts only once mounted, so the
  prerendered HTML holds its first frame.
- Landing pieces live in `apps/site/src/components`, not in the design system. Responsive down to 360 px
  wide; no horizontal scroll.

## 5. Content

Every claim on the page must have a source in the repository. All numbers, lists, links and code live in
`src/content.ts` so they can be checked against their sources in one place (`test/content.test.ts`).

1. **Header** — mark and wordmark · Benchmarks · Features · From Convex · Status (anchors) · *Docs* (disabled,
   "soon") · GitHub.
2. **Hero** — a pill with the share of Convex's inventory that is done (computed from the parity counts);
   headline *"The reactive backend, built for Bun."*; a subline; an install box with tabs (bun, docker, the
   executable), each line a command from `packages/cli/README.md` or `docker/README.md`; CTAs **Try an
   example** (primary) and **Star on GitHub**; the live demo.
3. **Proof strip** — the speed-ups over Convex self-hosted on the same Postgres (computed from the benchmark
   cells) and the fan-out run Convex could not finish.
4. **Benchmarks** — from `docs/bench/E2E-VPS-2026-10-05.md`: one tab per workload with bars for Convex
   (Postgres 17), bunvex on the same Postgres and bunvex on SQLite; the caption (machine, databases, which
   direction is better), a link to the full report, and every number in one table.
5. **The whole backend** — `examples/tutorial`'s `messages.ts` as it is and its `App.tsx` with some lines left
   out (each kept line is the file's), and what the reader did not have to write, each linked to its study.
6. **Features** — a grid of what the engine and server do (reactive queries, transactions, scheduler, search,
   storage, auth, HTTP actions, CLI, observability) and the dashboard as *coming*; each links to its study or
   README.
7. **Databases** — the five drivers, each passing PERSIST-01; the three ways to run a deployment.
8. **Coming from Convex** — the facts that make a move cheap (the official client works, snapshots move both
   ways, the examples, the nightly comparison), the import diff, and the parity counts of
   `docs/parity/README.md`.
9. **Status** — the roadmap phases of `docs/parity/README.md`, each marked done when its status line says
   **Done.**, else what is left; a link to the parity tables.
10. **Closing call to action** and **footer** — Apache-2.0 · GitHub · *"bunvex is an independent
    implementation written from scratch. It is not affiliated with Convex, Inc."*

**Naming Convex.** The page names Convex as the reference, in the benchmark and in the migration section (the
owner approved this on 29 Sep 2026). It uses no Convex logo, colors, or visual identity.

**SEO.** `<title>`, meta description, canonical `https://bunvex.dev/`, Open Graph and Twitter card tags,
a static `og.png` (1200×630) committed to `public/`, `robots.txt`, `sitemap.xml`.

## 6. Testing and verification

- **Smoke test:** renders the landing route and asserts the hero headline, the CTA hrefs, the tabs (click and
  arrow keys), the live demo's first frame, the benchmark bars and table (every number from `content.ts`),
  the roadmap, and the not-affiliated notice.
- **Content test:** every number, command, code line, count and repository link against its source (§5).
- **Hydration:** the prerendered HTML hydrates without a mismatch.
- **Accessibility:** axe-core on the rendered page (dark, the only theme), with no violations.
- **Build:** `bun run build:site` produces `index.html` with the content prerendered (not an empty
  shell); the test checks the built HTML for the headline.
- **Manual review before commit:** the owner and Claude review the page in a browser via Playwright
  (desktop and 375 px, light and dark) before anything is committed or a PR is opened.
- `bun run check` passes.

## 7. Open questions

None. Decided with the owner on 29 Sep 2026: landing + base for docs; GitHub as the only CTA; static
prerender; same design system; Convex-shaped code with a *target API* label; Convex named in the
benchmark.

Decided with the owner on 8 Oct 2026 (v2), from the prototype: the Bun-family dark design with the site's own
palette, dark only; **Try an example** as the primary action; the sections of §5; a provisional mark. Still to
decide: a real logo, a new `og.png` in the v2 design (the committed one is v1's), and whether a light theme
comes back.
