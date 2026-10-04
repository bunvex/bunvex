// Run under Bun (`bun --bun vite`, the package scripts): the workspace packages export TypeScript sources.
import { themeScript } from "@bunvex/ui/theme-script";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => ({
  // a second page: the design system's (UI-01 §17.5), at /design-system.html
  build: { rollupOptions: { input: { index: "index.html", "design-system": "design-system.html" } } },
  plugins: [
    react(),
    tailwindcss(),
    // apply the stored theme before first paint (no flash of the wrong theme)
    { name: "bunvex-theme", transformIndexHtml: () => [{ tag: "script", children: themeScript(), injectTo: "head" }] },
    // the parent origins allowed to hand an embedded dashboard its credentials (src/login/embedded.ts): always
    // written, empty when VITE_BUNVEX_EMBED_ORIGINS is unset, so an operator can also set them in a built index.html
    {
      name: "bunvex-embed-origins",
      transformIndexHtml: (_html, ctx) =>
        ctx.path === "/index.html"
          ? [
              {
                tag: "meta",
                attrs: {
                  name: "bunvex-embed-origins",
                  content: loadEnv(mode, import.meta.dirname, "VITE_").VITE_BUNVEX_EMBED_ORIGINS ?? "",
                },
                injectTo: "head",
              },
            ]
          : [],
    },
  ],
}));
