// `/database` on a deployment with no tables at all (STUDY-12 D11), as Convex's `EmptyData.tsx`: "There are no
// tables here yet", and — when this credential may create one — Create table, which opens the new table.
// Otherwise tables appear once data is written. In the same frame as a table (UX2-4): the section column
// (search, Create table, an empty Tables list) and Bar 1, with the empty state centred where the grid goes.
import { Table2 } from "lucide-react";
import { BAR_TITLE, BAR1 } from "../shell/bars.ts";
import { CreateTable, useCanCreateTable } from "./create-table.tsx";
import { TablesSidebar } from "./tables-sidebar.tsx";

export function EmptyDatabase() {
  const canCreate = useCanCreateTable();
  return (
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] flex-col md:-m-6 lg:h-[calc(100svh-3rem)] lg:flex-row">
      <TablesSidebar tables={[]} current="" canCreate={canCreate === true} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={BAR1}>
          <h1 className={BAR_TITLE}>Database</h1>
          <span className="text-sm text-muted-foreground">No tables yet</span>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <section
            aria-labelledby="no-tables"
            className="flex max-w-sm flex-col items-center gap-2 text-center text-sm"
          >
            <Table2 aria-hidden="true" className="size-6 text-muted-foreground" />
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
            {/* from lg the column's Create table is beside it; below, the column is hidden: offer it here */}
            {canCreate && (
              <div className="mt-2 w-full lg:hidden">
                <CreateTable tables={[]} />
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
