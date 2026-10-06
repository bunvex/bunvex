// The server's version: the `@bunvex/server` package's semver, as Convex's server version is its release's.
import pkg from "../package.json";

export const SERVER_VERSION: string = pkg.version;
