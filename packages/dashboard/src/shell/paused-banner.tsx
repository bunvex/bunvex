// Every screen says when the deployment is paused (UI-01 §17.2), as Convex's dashboard layout does, with a
// link to where it is resumed. Nothing for a source that does not offer pausing.
import { useQuery } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { deploymentStateQuery } from "../data/queries.ts";
import { DashLink } from "../router.tsx";

export function PausedBanner() {
  const { data } = useQuery(deploymentStateQuery(useQueryScope()));
  if (data?.state !== "paused") return null;
  return (
    <div role="status" className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-center text-sm">
      This deployment is paused: new function calls fail. Resume it in{" "}
      <DashLink link={{ to: "/settings/general" }} className="font-medium underline underline-offset-4">
        Settings
      </DashLink>
      .
    </div>
  );
}
