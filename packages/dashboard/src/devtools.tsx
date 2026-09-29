// The TanStack devtools, in their own module so a host that does not ask for them never loads them.
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { DashboardRouter } from "./router.tsx";

export default function Devtools({ router }: { router: DashboardRouter }) {
  return (
    <>
      <ReactQueryDevtools buttonPosition="bottom-left" />
      <TanStackRouterDevtools router={router} position="bottom-right" />
    </>
  );
}
