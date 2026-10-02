// A run's status said the same way on every screen (UX-11): an icon and a sentence-case word in the status
// colours — never the colour alone — with optional detail after it (e.g. a duration).
import { cn } from "@bunvex/ui/lib/utils";
import {
  Archive,
  BadgeCheck,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  LoaderCircle,
  ToggleLeft,
  ToggleRight,
  UserX,
} from "lucide-react";
import type { ReactNode } from "react";

export type Status =
  | "success"
  | "failure"
  | "pending"
  | "running"
  | "canceled"
  | "skipped"
  // a state rather than a run's outcome (UX2-12): a flag, a user, a session
  | "on"
  | "off"
  | "archived"
  | "verified"
  | "unverified"
  | "banned"
  | "active"
  | "revoked";

const LOOK: Record<Status, { label: string; icon: typeof CircleCheck; className: string }> = {
  success: { label: "Success", icon: CircleCheck, className: "text-success" },
  failure: { label: "Failure", icon: CircleX, className: "text-destructive" },
  pending: { label: "Pending", icon: CircleDashed, className: "text-muted-foreground" },
  running: { label: "Running", icon: LoaderCircle, className: "text-info" },
  canceled: { label: "Canceled", icon: Ban, className: "text-muted-foreground" },
  skipped: { label: "Skipped", icon: CircleSlash, className: "text-muted-foreground" },
  on: { label: "On", icon: ToggleRight, className: "text-success" },
  off: { label: "Off", icon: ToggleLeft, className: "text-muted-foreground" },
  archived: { label: "Archived", icon: Archive, className: "text-muted-foreground" },
  verified: { label: "Verified", icon: BadgeCheck, className: "text-success" },
  unverified: { label: "Unverified", icon: CircleDashed, className: "text-muted-foreground" },
  banned: { label: "Banned", icon: UserX, className: "text-destructive" },
  active: { label: "Active", icon: CircleCheck, className: "text-success" },
  revoked: { label: "Revoked", icon: Ban, className: "text-muted-foreground" },
};

function StatusBadge({ status, children, className }: { status: Status; children?: ReactNode; className?: string }) {
  const { label, icon: Icon, className: tone } = LOOK[status];
  return (
    <span
      data-slot="status-badge"
      data-status={status}
      className={cn("inline-flex items-center gap-1 text-xs", className)}
    >
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", tone)} />
      <span className={cn((status === "failure" || status === "banned") && "text-destructive")}>{label}</span>
      {children !== undefined && (
        <>
          {" "}
          <span className="text-muted-foreground tabular-nums">{children}</span>
        </>
      )}
    </span>
  );
}

export { StatusBadge };
