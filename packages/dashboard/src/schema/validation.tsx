// A schema being checked against the stored documents, or rejected by them (STUDY-12 §14.7), said where the
// schema is shown: the Schema screen's bar and the Database schema panel. As Convex's `ShowSchema.tsx`: a
// progress bar capped at 99 % (the total may come from another snapshot than the count), or a spinner while the
// total is unknown; and, when it fails, how many documents do not match and a few of them, each one opening.
import { CircleX, LoaderCircle } from "lucide-react";
import type { SchemaValidation } from "../data-source.ts";
import { DashLink } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";

/** The share validated, capped at 99 % (Convex's reason), or `null` while the total is unknown. */
export function validatedShare(v: Extract<SchemaValidation, { state: "validating" }>): number | null {
  if (v.totalDocs === null || v.totalDocs === 0) return null;
  return Math.min(0.99, v.numDocsValidated / v.totalDocs);
}

export function SchemaValidationStatus({ validation, compact }: { validation: SchemaValidation; compact?: boolean }) {
  if (validation.state === "validating") {
    const share = validatedShare(validation);
    return (
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        {share === null && (
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
        )}
        <span>Validating the schema against the stored documents…</span>
        {share !== null && (
          <>
            <div
              role="progressbar"
              aria-label="Schema validation progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
              className="h-1.5 w-24 shrink-0 bg-muted"
            >
              <div className="h-full bg-primary" style={{ width: `${share * 100}%` }} />
            </div>
            <span className="tabular-nums">{Math.round(share * 100)}%</span>
          </>
        )}
      </div>
    );
  }
  const n = validation.failedDocs;
  return (
    <div role="alert" className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="flex items-center gap-1.5 text-destructive">
        <CircleX aria-hidden="true" className="size-4 shrink-0" />
        {`Schema validation failed: ${formatCount(n)} ${n === 1 ? "document does" : "documents do"} not match.`}
      </span>
      {!compact && validation.sample.length > 0 && (
        <ul className="flex flex-col gap-0.5 pl-5.5 text-xs">
          {validation.sample.map((d) => (
            <li key={`${d.table}/${d.id}`} className="min-w-0">
              <DashLink
                link={{ to: "/database/$table", params: { table: d.table }, search: { doc: d.id } }}
                className="font-mono text-primary underline-offset-2 hover:underline"
              >
                {`${d.table} ${d.id}`}
              </DashLink>{" "}
              <span className="text-muted-foreground">{d.error}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
