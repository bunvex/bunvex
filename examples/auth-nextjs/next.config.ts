import type { NextConfig } from "next";

const config: NextConfig = {
  // `create-next-app` turns on Cache Components; the example does too.
  cacheComponents: true,
  // bunvex's packages are TypeScript sources: Next compiles them like the app's own code.
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
