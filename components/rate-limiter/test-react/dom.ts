// The DOM for the hook's tests, preloaded before any test file loads: React DOM and Testing Library read `window`
// and `document` when they are first evaluated.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
