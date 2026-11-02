// The DOM for the client tests, preloaded before any test file loads: React DOM and Testing Library read `window` and
// `document` when they are first evaluated, and the OAuth client the page's URL and history.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
