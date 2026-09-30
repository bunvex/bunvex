// Run after `vite build` (the package's build script): fails the build unless the landing page was
// prerendered with its content — not an empty shell that only fills in once JavaScript runs (SITE-01 §6).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HERO, SITE } from "../src/content.ts";

const OUT = resolve(import.meta.dir, "../dist/client");
const problems: string[] = [];
const html = existsSync(join(OUT, "index.html")) ? readFileSync(join(OUT, "index.html"), "utf8") : "";

if (!html) problems.push(`${OUT}/index.html is missing`);
else {
  if (!/<h1[\s>]/.test(html) || !html.includes(HERO.headline))
    problems.push("index.html has no prerendered <h1> headline");
  if (!html.includes(`<link rel="canonical" href="${SITE.url}/"`)) problems.push("index.html has no canonical link");
  if (!html.includes('property="og:image"')) problems.push("index.html has no og:image");
}
for (const file of ["sitemap.xml", "robots.txt", "og.png", "favicon.svg"])
  if (!existsSync(join(OUT, file))) problems.push(`${file} is missing`);

const SITEMAP_NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
if (existsSync(join(OUT, "sitemap.xml")) && !readFileSync(join(OUT, "sitemap.xml"), "utf8").includes(SITEMAP_NS))
  problems.push(`sitemap.xml does not declare the sitemap protocol namespace (${SITEMAP_NS})`);

if (problems.length) {
  console.error(`verify-build: ${problems.length} problem(s)\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log("verify-build: prerendered landing, canonical, og:image and sitemap present");
