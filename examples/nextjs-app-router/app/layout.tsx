import type { ReactNode } from "react";
import { BunvexClientProvider } from "./BunvexClientProvider";

export const metadata = { title: "bunvex + Next.js" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BunvexClientProvider>{children}</BunvexClientProvider>
      </body>
    </html>
  );
}
