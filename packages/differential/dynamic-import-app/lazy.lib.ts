// A module only a dynamic import reaches (a chunk under `_deps/`): it loads, and counts how many times, on first import.
(globalThis as { lazyLoads?: number }).lazyLoads = ((globalThis as { lazyLoads?: number }).lazyLoads ?? 0) + 1;
export const lazy = "loaded";
