// Run under Bun (`bun --bun vite`, the package scripts): the workspace packages export TypeScript sources.
// The whole site is prerendered to static HTML (SITE-01 §2); any static host can serve dist/client.
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { SITE } from "./src/content.ts";

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
      sitemap: { enabled: true, host: SITE.url },
    }),
    react(),
  ],
});
