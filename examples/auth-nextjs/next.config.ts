import type { NextConfig } from "next";

// bunvex's packages are TypeScript sources: Next compiles them like the app's own code.
const config: NextConfig = {
  transpilePackages: [
    "@bunvex/auth",
    "@bunvex/client",
    "@bunvex/core",
    "@bunvex/nextjs",
    "@bunvex/protocol",
    "@bunvex/rate-limiter",
    "@bunvex/react",
    "@bunvex/server",
    "@bunvex/values",
  ],
};

export default config;
