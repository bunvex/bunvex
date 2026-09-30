// `/database` on a deployment with no tables at all (STUDY-12 D11), as Convex's `EmptyData.tsx`: "There are no
// tables here yet", and — when this credential may create one — the table list's Create table, which opens
// the new table. Otherwise tables appear once data is written.
import { Table2 } from "lucide-react";
import { CreateTable, useCanCreateTable } from "./create-table.tsx";

export function EmptyDatabase() {
  const canCreate = useCanCreateTable();
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Database</h1>
      <section
        aria-labelledby="no-tables"
        className="mt-6 flex max-w-sm flex-col items-start gap-2 border border-dashed p-6 text-sm"
      >
        <Table2 aria-hidden="true" className="size-5 text-muted-foreground" />
        <h2 id="no-tables" className="font-medium">
          There are no tables here yet.
        </h2>
        {/* nothing until the capabilities are known, so the wrong advice never flashes */}
        {canCreate !== undefined && (
          <p className="text-muted-foreground">
            {canCreate
              ? "Create a table to start storing data."
              : "Tables appear once data is written: insert a document from a mutation."}
          </p>
        )}
        {canCreate && (
          <div className="mt-2 w-full">
            <CreateTable tables={[]} />
          </div>
        )}
      </section>
    </>
  );
}
