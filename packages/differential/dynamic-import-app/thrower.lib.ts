// A module that throws while loading. Its name has two dots, so neither CLI makes it a function module: it is bundled
// into a chunk under `_deps/`, which a push does not evaluate, and which loads only when a function imports it.
throw new Error("boom");
