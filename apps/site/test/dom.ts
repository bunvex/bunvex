// The DOM for this app's tests, preloaded by bunfig.toml before any test file loads (as in packages/ui).
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  localStorage.clear();
});
