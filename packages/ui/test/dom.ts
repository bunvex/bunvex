// The DOM for this package's tests, preloaded by bunfig.toml before any test file loads — React DOM,
// Base UI and Testing Library read `window` / `document` when they are first evaluated. These tests run
// in their own process (the root script), so happy-dom's globals never reach the engine or server tests.
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  localStorage.clear();
});
