// Run under Bun (`bun --bun vite`, the package scripts): the workspace packages export TypeScript sources.
import { themeScript } from "@bunvex/ui/theme-script";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // a second page: the design system's (UI-01 §17.5), at /design-system.html
  build: { rollupOptions: { input: { index: "index.html", "design-system": "design-system.html" } } },
  plugins: [
    react(),
    tailwindcss(),
    // apply the stored theme before first paint (no flash of the wrong theme)
    { name: "bunvex-theme", transformIndexHtml: () => [{ tag: "script", children: themeScript(), injectTo: "head" }] },
  ],
});
