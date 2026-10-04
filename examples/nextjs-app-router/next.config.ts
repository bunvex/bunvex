import type { NextConfig } from "next";

// bunvex's packages are TypeScript sources (STUDY-40's preview): Next compiles them like the app's own code.
const config: NextConfig = {
  transpilePackages: [
    "bunvex",
    "@bunvex/client",
    "@bunvex/core",
    "@bunvex/nextjs",
    "@bunvex/protocol",
    "@bunvex/react",
    "@bunvex/server",
    "@bunvex/values",
  ],
};

export default config;
