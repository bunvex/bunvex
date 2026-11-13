import { type ReactNode, Suspense } from "react";
import { BunvexAuthNextjsServerProvider } from "../lib/bunvexAuth";

export const metadata = { title: "bunvex auth + Next.js" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 24 }}>
        {/* The provider reads the auth cookies, so with Cache Components it renders inside a Suspense boundary. */}
        <Suspense>
          <BunvexAuthNextjsServerProvider>{children}</BunvexAuthNextjsServerProvider>
        </Suspense>
      </body>
    </html>
  );
}
