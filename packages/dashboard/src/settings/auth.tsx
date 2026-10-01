// Settings → Authentication (UI-01 §19.1, STUDY-12 §13.1), as Convex's page (`AuthenticationView.tsx`,
// `AuthConfig.tsx`): the providers the deployment accepts tokens from — OIDC (domain, application ID) or
// custom JWT (issuer, JWKS URL, algorithm, application ID) — each value with a copy button; with none, where
// they are declared (Convex links its docs; bunvex has no docs site yet). Reading them needs `viewData` and `viewEnvironmentVariables`, as in Convex.
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Skeleton } from "@bunvex/ui/components/skeleton";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, dashboardKeys, type QueryScope } from "../data/queries.ts";
import { type AuthProvider, toDataSourceError } from "../data-source.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { SettingsLayout } from "./layout.tsx";

export const authProvidersQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: [...dashboardKeys.all(scope), "auth-providers"] as const,
    queryFn: ({ signal }) => source.listAuthProviders!({ signal }),
  });

export function AuthenticationSettingsScreen() {
  const { source } = useQueryScope();
  if (typeof source.listAuthProviders !== "function") return <NotOffered title="Settings" what="authentication" />;
  return (
    <SettingsLayout title="Authentication" description="The identity providers this deployment trusts">
      <Authentication />
    </SettingsLayout>
  );
}

function Authentication() {
  const scope = useQueryScope();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const allowed =
    caps === undefined ||
    (caps.operations.includes("viewData") && caps.operations.includes("viewEnvironmentVariables"));
  const providers = useQuery({ ...authProvidersQuery(scope), enabled: caps !== undefined && allowed });
  return (
    <section aria-labelledby="auth-config" className="max-w-3xl">
      <h2 id="auth-config" className="text-base font-medium">
        Authentication
      </h2>
      {!allowed ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This credential cannot view the authentication configuration: it needs to view both data and environment
          variables.
        </p>
      ) : providers.isPending ? (
        <Skeleton className="mt-3 h-32 w-full" />
      ) : providers.error ? (
        <ErrorState error={toDataSourceError(providers.error)} onRetry={() => void providers.refetch()} />
      ) : providers.data.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This deployment has no authentication providers yet. They are declared in{" "}
          <code className="font-mono text-xs">auth.config.ts</code> and appear here once it is deployed.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            The providers this deployment accepts tokens from, as declared in{" "}
            <code className="font-mono text-xs">auth.config.ts</code>.
          </p>
          <ul className="mt-3 flex flex-col divide-y border-y">
            {providers.data.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: providers have no id; their order is the config's
              <Provider key={i} provider={p} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Attribute({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid gap-1 py-1.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 font-mono text-xs break-all">{value}</code>
        <CopyButton text={value} label={`Copy the ${term}`} />
      </dd>
    </div>
  );
}

function Provider({ provider: p }: { provider: AuthProvider }) {
  const kind = p.type === "customJwt" ? "Custom JWT provider" : "OIDC provider";
  const name = p.type === "customJwt" ? p.issuer : p.domain;
  return (
    <li className="py-3" aria-label={`${kind}: ${name}`}>
      <p className="text-sm font-medium">{kind}</p>
      <dl className="mt-1">
        {p.type === "customJwt" ? (
          <>
            <Attribute term="Issuer" value={p.issuer} />
            <Attribute term="JWKS URL" value={p.jwks} />
            <Attribute term="Algorithm" value={p.algorithm} />
            {p.applicationID !== undefined && <Attribute term="Application ID" value={p.applicationID} />}
          </>
        ) : (
          <>
            <Attribute term="Domain" value={p.domain} />
            <Attribute term="Application ID" value={p.applicationID} />
          </>
        )}
      </dl>
    </li>
  );
}
