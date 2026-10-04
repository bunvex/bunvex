import { BunvexProvider, BunvexReactClient } from "bunvex/react";
import type { AppProps } from "next/app";

// `bunvex dev` writes the deployment's URL to .env.local as NEXT_PUBLIC_BUNVEX_URL.
const bunvex = new BunvexReactClient(process.env.NEXT_PUBLIC_BUNVEX_URL as string);

export default function App({ Component, pageProps }: AppProps) {
  return (
    <BunvexProvider client={bunvex}>
      <Component {...pageProps} />
    </BunvexProvider>
  );
}
