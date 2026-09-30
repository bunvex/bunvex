// Settings → General (UI-01 §17.1, STUDY-12 §11): what this deployment is and where it answers — its
// name, version and persistence, and its URLs with copy buttons: the client URL (what `ConvexClient` or
// `CONVEX_URL` takes) and the HTTP actions URL (Convex's `CONVEX_SITE_URL`). Convex shows the two URLs in
// the Health summary (`DeploymentSummary.tsx`) and on its cloud "URL & Deploy Key" page; bunvex keeps
// them on General, next to pausing (§17.2). A URL the source does not give is left out.
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Skeleton } from "@bunvex/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useQueryScope } from "../context.tsx";
import { deploymentQuery } from "../data/queries.ts";
import { toDataSourceError } from "../data-source.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { SettingsLayout } from "./layout.tsx";
import { PauseSection } from "./pause.tsx";

export function GeneralSettingsScreen() {
  return (
    <SettingsLayout>
      <div className="flex flex-col gap-8">
        <DeploymentInfoSection />
        <PauseSection />
      </div>
    </SettingsLayout>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b py-3 last:border-b-0 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function Url({ href, label }: { href: string; label: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 font-mono text-xs break-all">{href}</code>
      <CopyButton text={href} label={`Copy the ${label}`} />
    </span>
  );
}

function DeploymentInfoSection() {
  const { data, error, isPending, refetch } = useQuery(deploymentQuery(useQueryScope()));
  return (
    <section aria-labelledby="deployment-info" className="max-w-3xl">
      <h2 id="deployment-info" className="text-base font-medium">
        Deployment
      </h2>
      {isPending ? (
        <Skeleton className="mt-3 h-32 w-full" />
      ) : error ? (
        <ErrorState error={toDataSourceError(error)} onRetry={() => void refetch()} />
      ) : (
        <dl className="mt-2">
          <Row term="Name">{data.name}</Row>
          <Row term="Version">
            <code className="font-mono text-xs">{data.version}</code>
          </Row>
          <Row term="Persistence">{data.persistence}</Row>
          {data.url && (
            <Row term="Client URL">
              <Url href={data.url} label="client URL" />
            </Row>
          )}
          {data.httpActionsUrl && (
            <Row term="HTTP actions URL">
              <Url href={data.httpActionsUrl} label="HTTP actions URL" />
            </Row>
          )}
        </dl>
      )}
    </section>
  );
}
