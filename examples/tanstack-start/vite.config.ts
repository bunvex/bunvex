// TanStack Start renders each page on the server, then hydrates it. It runs under Bun (`bun --bun vite`, the package
// scripts): in this repository the @bunvex/* packages are TypeScript sources, which Bun loads as they are.
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackStart(), react()],
});
