// The header's account entry (STUDY-12 §19): which deployment the dashboard is signed in to — or that it shows
// the demo data — and the way out, as Convex's header menu offers "Log Out" (`_app.tsx`, `Header`).
import { Button } from "@bunvex/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bunvex/ui/components/dropdown-menu";
import { LogOut, Server } from "lucide-react";

export type AccountMenuProps = (
  | { kind: "demo"; onSignOut: () => void }
  | { kind: "deployment"; deploymentUrl: string; deploymentName?: string; readOnly: boolean; onSignOut: () => void }
) & { defaultOpen?: boolean };

export const accountTitle = (p: AccountMenuProps) =>
  p.kind === "demo" ? "Demo data" : (p.deploymentName ?? new URL(p.deploymentUrl).host);

export function AccountMenu(props: AccountMenuProps) {
  const title = accountTitle(props);
  return (
    <DropdownMenu defaultOpen={props.defaultOpen}>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" aria-label={`Signed in: ${title}`}>
            <Server aria-hidden="true" />
            <span className="max-w-40 truncate">{title}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            {props.kind === "demo" ? (
              <>
                <span className="text-foreground">Demo data</span>
                <span className="font-normal">Sample data in this browser — no deployment.</span>
              </>
            ) : (
              <>
                <span className="text-foreground">{props.deploymentName ?? "Deployment"}</span>
                <span className="truncate font-mono font-normal">{props.deploymentUrl}</span>
                {props.readOnly && <span className="font-normal">Read-only admin key</span>}
              </>
            )}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={props.onSignOut}>
          <LogOut aria-hidden="true" />
          {props.kind === "demo" ? "Leave the demo" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
