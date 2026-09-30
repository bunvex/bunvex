// The DOM for this package's tests, preloaded by bunfig.toml before any test file loads — React DOM,
// Base UI and Testing Library read `window` / `document` when they are first evaluated. These tests run
// in their own process (the root script), so happy-dom's globals never reach the engine or server tests.
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

// Monaco needs layout and workers: the code editor's plain field (same keys, same labels) stands in.
const { setCodeEditorImplementation } = await import("@bunvex/ui/components/code-editor");
setCodeEditorImplementation("plain");

// happy-dom has no layout: every offsetHeight is 0, so a virtualized DataTable would render no row. Its
// scroll container (data-slot="data-table") gets the size a browser would give it: 360 × 800 px.
for (const [key, size] of Object.entries({ offsetHeight: 360, offsetWidth: 800 })) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)?.get;
  Object.defineProperty(HTMLElement.prototype, key, {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.slot === "data-table" ? size : (original?.call(this) ?? 0);
    },
  });
}

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  localStorage.clear();
});
