// Native database drivers are OPTIONAL peer dependencies: an app installs only the one it uses. Loading
// them lazily turns "Cannot find package" into a message that says what to install.
import { bundledModule } from "@bunvex/core";
export async function loadPeer<T>(specifier: string, pkg: string): Promise<T> {
  // A standalone executable carries its database clients (STUDY-39).
  const bundled = bundledModule<{ default?: T } & T>(specifier);
  if (bundled) return (bundled.default ?? bundled) as T;
  try {
    const mod = (await import(specifier)) as { default?: T } & T;
    return (mod.default ?? mod) as T;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || /Cannot find (package|module)/.test(String(e)))
      throw new Error(`@bunvex/persistence needs the "${pkg}" package for this driver: bun add ${pkg}`);
    throw e;
  }
}
