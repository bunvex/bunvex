// The header's account entry, light on the first load (STUDY-12 §19): a plain button until it is first used,
// then the menu (Base UI's, with its positioning) is fetched and opens in its place.
import { Button } from "@bunvex/ui/components/button";
import { Server } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { AccountMenuProps } from "./account-menu.tsx";

const AccountMenu = lazy(() => import("./account-menu.tsx").then((m) => ({ default: m.AccountMenu })));

export function AccountEntry(props: AccountMenuProps) {
  const [used, setUsed] = useState(false);
  const title = props.kind === "demo" ? "Demo data" : (props.deploymentName ?? new URL(props.deploymentUrl).host);
  const button = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Signed in: ${title}`}
      aria-haspopup="menu"
      onClick={() => setUsed(true)}
    >
      <Server aria-hidden="true" />
      <span className="max-w-40 truncate">{title}</span>
    </Button>
  );
  if (!used) return button;
  return (
    <Suspense fallback={button}>
      <AccountMenu {...props} defaultOpen />
    </Suspense>
  );
}
