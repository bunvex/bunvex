// The Database screen's destructive actions (UI-01 §12.3), each behind a confirmation that says what will
// happen: deleting the selected documents, and clearing or deleting a table — which ask for its name to be typed.
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@bunvex/ui/components/alert-dialog";
import { Button } from "@bunvex/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bunvex/ui/components/dropdown-menu";
import { Input } from "@bunvex/ui/components/input";
import { MoreHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { type DashboardDataSource, toDataSourceError } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";

/** At most this many ids per deleteDocuments call (the contract's bound). */
const DELETE_BATCH = 4096;
const docs = (n: number) => `${formatCount(n)} document${n === 1 ? "" : "s"}`;

export type Outcome = { ok: true; message: string } | { ok: false; message: string };

/** Deletes `ids` from `table` in bounded batches, and says how it went. */
export async function deleteDocumentsNow(source: DashboardDataSource, table: string, ids: string[]): Promise<Outcome> {
  try {
    for (let i = 0; i < ids.length; i += DELETE_BATCH)
      await source.deleteDocuments!(table, ids.slice(i, i + DELETE_BATCH));
    return { ok: true, message: `Deleted ${docs(ids.length)} from ${table}.` };
  } catch (e) {
    return { ok: false, message: `Could not delete: ${toDataSourceError(e).message}` };
  }
}

/** `onClosed` runs once the dialog is gone, whatever happened: the caller puts the focus somewhere useful. */
export function DeleteSelected(props: {
  table: string;
  ids: string[];
  onDone: (o: Outcome) => void;
  onClosed: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="destructive-outline" size="sm" onClick={() => setOpen(true)}>
        Delete {formatCount(props.ids.length)}
      </Button>
      <DeleteDialog
        {...props}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) props.onClosed();
        }}
      />
    </>
  );
}

/** Asks before deleting documents (the selected ones, or one from a cell's menu), then deletes them in batches. */
export function DeleteDialog(props: {
  table: string;
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (o: Outcome) => void;
}) {
  const { source } = useQueryScope();
  const [busy, setBusy] = useState(false);
  const n = props.ids.length;
  const confirm = async () => {
    setBusy(true);
    props.onDone(await deleteDocumentsNow(source, props.table, props.ids));
    setBusy(false);
    props.onOpenChange(false);
  };
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent
        // the caller puts the focus back (the Delete button that opened the dialog may be gone)
        finalFocus={false}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {docs(n)}?</AlertDialogTitle>
          <AlertDialogDescription>
            {n === 1 ? "It is" : "They are"} removed from {props.table} for every client at once. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep {n === 1 ? "it" : "them"}</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Deleting…" : `Delete ${docs(n)}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The "More" menu: actions on the whole table, and the panels (`panels`) whose buttons the title bar folds
 * away when it is narrow (UX-20; the bar's own width since UI-01 §22.3 — e.g. beside a docked panel), so it
 * keeps Add documents and ⋯ on one line. The menu lists them at every width (it opens outside the bar).
 */
export function TableMenu(props: {
  table: string;
  count?: number;
  canClear: boolean;
  onDone: (o: Outcome) => void;
  panels?: { label: string; open: () => void }[];
  /**
   * Deleting the table (Convex's "Delete Table", `/api/delete_tables`): offered when it may write and the source
   * can; disabled while the schema declares the table, as Convex's menu. `onDeleted` runs once it is gone.
   */
  canDelete?: boolean;
  declared?: boolean;
  onDeleted?: (o: Outcome) => void;
}) {
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const panels = props.panels ?? [];
  const canDelete = props.canDelete === true;
  if (!props.canClear && !canDelete && panels.length === 0) return null;
  const destructive = props.canClear || canDelete;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions on ${props.table}`}
              // with nothing to clear or delete, the menu only holds the phone's panels
              className={destructive ? undefined : "@2xl/table:hidden"}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {panels.map((p) => (
            <DropdownMenuItem key={p.label} onClick={p.open}>
              {p.label}
            </DropdownMenuItem>
          ))}
          {panels.length > 0 && destructive && <DropdownMenuSeparator />}
          {props.canClear && (
            <DropdownMenuItem variant="destructive" onClick={() => setClearing(true)}>
              Clear table…
            </DropdownMenuItem>
          )}
          {canDelete &&
            (props.declared ? (
              // Convex's menu: a table the schema declares is deleted by removing it from the schema first
              <DropdownMenuItem disabled>Delete table (declared in the schema)</DropdownMenuItem>
            ) : (
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                Delete table…
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <ClearTable {...props} open={clearing} onOpenChange={setClearing} />
      {canDelete && (
        <DeleteTable
          table={props.table}
          open={deleting}
          onOpenChange={setDeleting}
          onDone={(o) => (o.ok ? props.onDeleted?.(o) : props.onDone(o))}
        />
      )}
    </>
  );
}

/**
 * Clearing a table, its name typed to confirm: from the menu, and from "Delete all" with every document selected
 * (Convex's toolbar opens its clear dialog for that too, `DataToolbar.tsx`).
 */
export function ClearTable(props: {
  table: string;
  count?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (o: Outcome) => void;
}) {
  const { source } = useQueryScope();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const matches = typed === props.table;
  const close = (open: boolean) => {
    if (!open) setTyped("");
    props.onOpenChange(open);
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const { deleted } = await source.clearTable!(props.table);
      props.onDone({ ok: true, message: `Cleared ${props.table}: ${docs(deleted)} deleted.` });
    } catch (e) {
      props.onDone({ ok: false, message: `Could not clear ${props.table}: ${toDataSourceError(e).message}` });
    }
    setBusy(false);
    close(false);
  };
  return (
    <AlertDialog open={props.open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear {props.table}?</AlertDialogTitle>
          <AlertDialogDescription>
            Deletes {props.count === undefined ? "every document" : `all ${docs(props.count)}`} of {props.table}. The
            table and its indexes stay. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !busy) void confirm();
          }}
        >
          <label htmlFor={inputId} className="text-sm">
            Type <strong className="font-mono">{props.table}</strong> to confirm
          </label>
          <Input id={inputId} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Keep the data</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={!matches || busy}>
              {busy ? "Clearing…" : `Clear ${props.table}`}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Deleting the whole table: its documents and its indexes, in one go (Convex's `/api/delete_tables`). */
function DeleteTable(props: {
  table: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (o: Outcome) => void;
}) {
  const { source } = useQueryScope();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const matches = typed === props.table;
  const close = (open: boolean) => {
    if (!open) setTyped("");
    props.onOpenChange(open);
  };
  const confirm = async () => {
    setBusy(true);
    let outcome: Outcome;
    try {
      await source.deleteTables!([props.table]);
      outcome = { ok: true, message: `Deleted the table ${props.table}.` };
    } catch (e) {
      outcome = { ok: false, message: `Could not delete ${props.table}: ${toDataSourceError(e).message}` };
    }
    setBusy(false);
    close(false);
    props.onDone(outcome);
  };
  return (
    <AlertDialog open={props.open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the table {props.table}?</AlertDialogTitle>
          <AlertDialogDescription>
            Deletes {props.table} with every document and index in it. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !busy) void confirm();
          }}
        >
          <label htmlFor={inputId} className="text-sm">
            Type <strong className="font-mono">{props.table}</strong> to confirm
          </label>
          <Input id={inputId} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Keep the table</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={!matches || busy}>
              {busy ? "Deleting…" : `Delete ${props.table}`}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
