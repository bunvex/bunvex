// Settings → General → Pause deployment (UI-01 §17.2, STUDY-12 §11), as Convex's `PauseDeployment.tsx`:
// the state in words, one button — Pause (destructive) or Resume — gated on its operation, a confirmation
// naming the deployment, and what either does. Shown only when the source offers pausing.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, deploymentQuery, deploymentStateQuery } from "../data/queries.ts";
import { ConfirmButton } from "../shell/confirm.tsx";

const PAUSING = [
  "New function calls will return an error.",
  "Scheduled functions wait, and run when the deployment is resumed.",
  "Cron jobs are skipped.",
];
const RESUMING = [
  "New function calls can be made.",
  "Functions scheduled before the pause will run.",
  "Cron jobs resume on their schedule.",
];

export function PauseSection() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const { data: state } = useQuery(deploymentStateQuery(scope));
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const { data: deployment } = useQuery(deploymentQuery(scope));
  if (!source.getDeploymentState || !source.pauseDeployment || !source.resumeDeployment) return null;
  const paused = state?.state === "paused";
  const op = paused ? "resumeDeployment" : "pauseDeployment";
  const allowed = !!caps && !caps.readOnly && caps.operations.includes(op);
  const verb = paused ? "Resume" : "Pause";
  const name = deployment?.name ?? "this deployment";
  return (
    <section aria-labelledby="pause-deployment" className="max-w-3xl">
      <h2 id="pause-deployment" className="text-base font-medium">
        Pause deployment
      </h2>
      {state && (
        <div className="mt-2 flex flex-col gap-3 text-sm">
          <p>
            This deployment is currently <strong>{paused ? "paused" : "running"}</strong>.
          </p>
          <p className="text-muted-foreground">{paused ? "Resuming it:" : "Pausing it:"}</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {(paused ? RESUMING : PAUSING).map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <div>
            <ConfirmButton
              label={`${verb} deployment`}
              variant={paused ? "default" : "destructive"}
              confirmVariant={paused ? "default" : "destructive"}
              disabled={!allowed}
              title={`${verb} ${name}?`}
              description={(paused ? RESUMING : PAUSING).join(" ")}
              confirm={`${verb} deployment`}
              busy={paused ? "Resuming…" : "Pausing…"}
              keep="Cancel"
              action={async () => {
                await (paused ? source.resumeDeployment!() : source.pauseDeployment!());
                await queryClient.invalidateQueries({ queryKey: deploymentStateQuery(scope).queryKey });
              }}
            />
            {!allowed && caps && (
              <p className="mt-2 text-muted-foreground">This credential cannot {verb.toLowerCase()} the deployment.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
