// TanStack Start 1.168 writes the sitemap with `xmlns="https://www.sitemaps.org/…"`, but the protocol's
// namespace is the http:// URI and search engines match it literally. Run after `vite build`.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(import.meta.dir, "../dist/client/sitemap.xml");
const xml = readFileSync(file, "utf8");
writeFileSync(file, xml.replace('xmlns="https://www.sitemaps.org/', 'xmlns="http://www.sitemaps.org/'));
