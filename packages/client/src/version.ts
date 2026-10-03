/**
 * The client version, in the sync URL (`/api/<version>/sync`) and the `Bunvex-Client` header, as Convex's
 * client puts its npm version there: the version of Convex's client this one follows (DV-225), so a server
 * gates features (transition chunks, prefix search) as it would for that client.
 */
export const VERSION = "1.46.0";
