// The Database screen's destructive actions (UI-01 §12.3), each behind a confirmation that says what will
// happen: deleting the selected documents, and clearing a table — which asks for its name to be typed.
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
  DropdownMenuTrigger,
} from "@bunvex/ui/components/dropdown-menu";
import { Input } from "@bunvex/ui/components/input";
import { MoreHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { toDataSourceError } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";

/** At most this many ids per deleteDocuments call (the contract's bound). */
const DELETE_BATCH = 4096;
const docs = (n: number) => `${formatCount(n)} document${n === 1 ? "" : "s"}`;

export type Outcome = { ok: true; message: string } | { ok: false; message: string };

/** `onClosed` runs once the dialog is gone, whatever happened: the caller puts the focus somewhere useful. */
export function DeleteSelected(props: {
  table: string;
  ids: string[];
  onDone: (o: Outcome) => void;
  onClosed: () => void;
}) {
  const { source } = useQueryScope();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = props.ids.length;
  const confirm = async () => {
    setBusy(true);
    try {
      for (let i = 0; i < n; i += DELETE_BATCH)
        await source.deleteDocuments!(props.table, props.ids.slice(i, i + DELETE_BATCH));
      props.onDone({ ok: true, message: `Deleted ${docs(n)} from ${props.table}.` });
    } catch (e) {
      props.onDone({ ok: false, message: `Could not delete: ${toDataSourceError(e).message}` });
    }
    setBusy(false);
    setOpen(false);
    props.onClosed();
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) props.onClosed();
      }}
    >
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Delete {formatCount(n)}
      </Button>
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

/** The "More" menu: actions on the whole table. */
export function TableMenu(props: { table: string; count?: number; canClear: boolean; onDone: (o: Outcome) => void }) {
  const [clearing, setClearing] = useState(false);
  if (!props.canClear) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`More actions on ${props.table}`} />}
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={() => setClearing(true)}>
            Clear table…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ClearTable {...props} open={clearing} onOpenChange={setClearing} />
    </>
  );
}

function ClearTable(props: {
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
