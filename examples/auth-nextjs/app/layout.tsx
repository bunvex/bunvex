import type { ReactNode } from "react";
import { BunvexAuthNextjsServerProvider } from "../lib/bunvexAuth";

export const metadata = { title: "bunvex auth + Next.js" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 24 }}>
        <BunvexAuthNextjsServerProvider>{children}</BunvexAuthNextjsServerProvider>
      </body>
    </html>
  );
}
