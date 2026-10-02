// The Schema screen (STUDY-12 §14, UI-01 §21), as Convex's (`features/schema/components/SchemaView.tsx`): the
// deployment's tables and the references between them, drawn as a diagram. It reads the declared schema, the
// tables (for their indexes, counts and the undeclared ones) and — where the source can — the document types of
// tables without a declared one. The diagram itself (xyflow, ELK) loads with this screen only.
import { Skeleton } from "@bunvex/ui/components/skeleton";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, inferredTypeQuery, schemaQuery, tablesQuery } from "../data/queries.ts";
import { toDataSourceError, type ValidatorJson } from "../data-source.ts";
import { BAR_TITLE } from "../shell/bars.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { SchemaDiagram } from "./diagram.tsx";
import { buildSchemaGraph } from "./graph.ts";
import { SchemaValidationStatus } from "./validation.tsx";

const Heading = () => <h1 className="text-xl font-semibold tracking-tight">Schema</h1>;

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="schema-empty"
      className="mt-6 flex max-w-md flex-col gap-2 border border-dashed p-6 text-sm"
    >
      <h2 id="schema-empty" className="font-medium">
        {title}
      </h2>
      <div className="text-muted-foreground">{children}</div>
    </section>
  );
}

export function SchemaScreen() {
  const scope = useQueryScope();
  const caps = useQuery(capabilitiesQuery(scope));
  const canView = caps.data?.operations.includes("viewData") ?? false;
  const schema = useQuery({ ...schemaQuery(scope), enabled: canView });
  const tables = useQuery({ ...tablesQuery(scope), enabled: canView });

  // tables whose type the schema does not give: typed from their documents, when the source can tell
  const declared = new Set(schema.data?.tables.filter((t) => t.validator).map((t) => t.name));
  const toInfer =
    typeof scope.source.inferDocumentType === "function"
      ? (tables.data ?? []).map((t) => t.name).filter((t) => !declared.has(t))
      : [];
  const inferred = useQueries({
    queries: toInfer.map((t) => ({ ...inferredTypeQuery(scope, t), staleTime: 60_000, enabled: canView })),
  });
  const inferredKey = inferred.map((q) => q.dataUpdatedAt).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `inferredKey` stands for the inferred types
  const graph = useMemo(() => {
    if (!schema.data || !tables.data) return undefined;
    const types: Record<string, ValidatorJson | null | undefined> = {};
    toInfer.forEach((t, i) => {
      types[t] = inferred[i]?.data;
    });
    return buildSchemaGraph(schema.data, tables.data, types);
  }, [schema.data, tables.data, inferredKey]);

  if (caps.data && !canView)
    return (
      <>
        <Heading />
        <Empty title="You cannot view the schema">This credential cannot view the deployment's data.</Empty>
      </>
    );
  const error = caps.error ?? schema.error ?? tables.error;
  if (error)
    return (
      <>
        <Heading />
        <div className="mt-4">
          <ErrorState
            error={toDataSourceError(error)}
            onRetry={() => {
              void schema.refetch();
              void tables.refetch();
            }}
          />
        </div>
      </>
    );
  if (graph === undefined)
    return (
      <>
        <Heading />
        <Skeleton className="mt-4 h-[60svh] w-full" />
      </>
    );
  if (graph === null)
    return (
      <>
        <Heading />
        <Empty title="This deployment doesn't have any tables">
          Create a table and declare it in <code className="font-mono text-xs">bunvex/schema.ts</code> with{" "}
          <code className="font-mono text-xs">defineSchema</code> to see your tables and the references between them.
        </Empty>
      </>
    );
  return (
    <SchemaDiagram
      graph={graph}
      heading={<h1 className={BAR_TITLE}>Schema</h1>}
      status={schema.data?.validation && <SchemaValidationStatus validation={schema.data.validation} compact />}
    />
  );
}
