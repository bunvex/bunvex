// Creating a table from the table list (STUDY-12 D11), as Convex's data sidebar does: "Create table" turns
// into a name box, checked as it is typed (taken, or not an identifier); Create makes the empty table and
// opens it; Cancel or Escape leaves things as they were.
import { Button } from "@bunvex/ui/components/button";
import { Input } from "@bunvex/ui/components/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, dashboardKeys } from "../data/queries.ts";
import { toDataSourceError } from "../data-source.ts";
import { tableRoute } from "../router.tsx";
import { tableNameProblem } from "./table-name.ts";

/**
 * Whether this credential may create a table here: it can write, and the source has `createTable`.
 * `undefined` until the capabilities are known.
 */
export function useCanCreateTable(): boolean | undefined {
  const scope = useQueryScope();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  if (!caps) return undefined;
  return !caps.readOnly && caps.operations.includes("writeData") && typeof scope.source.createTable === "function";
}

export function CreateTable({ tables }: { tables: string[] }) {
  const { source, scope } = useQueryScope();
  const queryClient = useQueryClient();
  const navigate = tableRoute.useNavigate();
  const [name, setName] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const errorId = useId();

  const close = () => {
    setName(undefined);
    setRefused(undefined);
    // back to the button that opened it (rendered again on the next frame)
    requestAnimationFrame(() => opener.current?.focus());
  };

  if (name === undefined)
    return (
      <Button ref={opener} variant="ghost" size="sm" className="w-full justify-start" onClick={() => setName("")}>
        <Plus aria-hidden="true" />
        Create table
      </Button>
    );

  // nothing is said about an empty box until something is typed
  const problem = tables.includes(name) ? `Table "${name}" already exists.` : name ? tableNameProblem(name) : undefined;
  const error = problem ?? refused;
  const create = async () => {
    if (!name || problem) return;
    setBusy(true);
    try {
      await source.createTable!(name);
    } catch (e) {
      setBusy(false);
      return setRefused(toDataSourceError(e).message);
    }
    await queryClient.invalidateQueries({ queryKey: dashboardKeys.tables(scope) });
    setBusy(false);
    setName(undefined);
    void navigate({ to: "/database/$table", params: { table: name } });
  };

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        New table's name
      </label>
      <Input
        id={inputId}
        autoFocus
        placeholder="Untitled table"
        value={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setName(e.target.value);
          setRefused(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      {error && (
        <p id={errorId} role={refused ? "alert" : undefined} className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name || !!problem || busy}>
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}
