import type { NextConfig } from "next";

// bunvex's packages are TypeScript sources: Next compiles them like the app's own code.
const config: NextConfig = {
  transpilePackages: [
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
