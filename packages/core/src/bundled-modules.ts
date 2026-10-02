// Modules a standalone build carries (STUDY-39): `bun build --compile` cannot follow an import whose
// specifier is computed, so the executable's entry imports the optional ones (the persistence drivers and
// their database clients) and registers them here; the loaders look here before importing.
const KEY = Symbol.for("bunvex.bundledModules");
type Registry = Map<string, unknown>;
const registry = (): Registry => {
  const g = globalThis as { [KEY]?: Registry };
  g[KEY] ??= new Map();
  return g[KEY];
};

/** Register modules by specifier (the standalone executable's entry). */
export function provideBundledModules(modules: Record<string, unknown>) {
  for (const [specifier, mod] of Object.entries(modules)) registry().set(specifier, mod);
}

/** A registered module, or undefined: then import it as usual. */
export const bundledModule = <T>(specifier: string): T | undefined => registry().get(specifier) as T | undefined;
