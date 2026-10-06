// The CLI's version: the standalone executable's (set at build, STUDY-39), else the package's. A push sends it
// as `udfServerVersion`, as Convex's CLI sends its package's version (STUDY-134).
declare const BUNVEX_BUILD_VERSION: string | undefined;
export const VERSION: string =
  typeof BUNVEX_BUILD_VERSION === "string" ? BUNVEX_BUILD_VERSION : (await import("../package.json")).version;
