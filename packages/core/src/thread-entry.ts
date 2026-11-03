// Where a Worker's module is, from the module that starts it: next to it when bunvex runs from its sources (or a
// package's), and at its place under `packages/` inside `bunvex-local-backend`. `scripts/build-binary.ts` embeds
// every Worker module as an entry point of its own with `--root` at `packages/`, so the executable holds
// `<packages-relative path>` at its embedded root; and there, every module's `import.meta.url` is the executable's
// own path at that root (`file:///$bunfs/root/bunvex-local-backend`), not its module's.

/**
 * True when `here` (a module's `import.meta.url`) is not a source file: the module is inside an executable.
 *
 * @internal
 */
export const inExecutable = (here: string) => !/\.[cm]?[jt]sx?$/.test(new URL(here).pathname);

/**
 * The URL to start a Worker at: `file`, beside the module whose `import.meta.url` is `here`; inside the executable,
 * `dir/file`, where `dir` is that module's directory under `packages/` (`core/src/persistence`).
 *
 * @internal
 */
export function threadEntry(here: string, dir: string, file: string): string {
  return new URL(inExecutable(here) ? `./${dir}/${file}` : `./${file}`, here).href;
}
