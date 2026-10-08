/**
 * The client's version, in the sync URL (`/api/<version>/sync`) and the `Bunvex-Client` header: its own
 * package's (`0.1.0-alpha.0` today), as Convex's client announces its npm version. bunvex is its own product; a
 * bunvex server does not gate features on Convex's client versions (STUDY-139 P1, DV-442).
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
