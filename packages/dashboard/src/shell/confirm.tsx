// A button that asks before a destructive action (an AlertDialog): Cancel a scheduled run, delete files,
// delete a variable. The action runs from the dialog; its error shows there, and it stays open.
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
import { type ReactNode, useState } from "react";
import { toDataSourceError } from "../data-source.ts";

export function ConfirmButton(props: {
  /** The button that opens the dialog. */
  label: ReactNode;
  disabled?: boolean;
  size?: "sm" | "default";
  variant?: "destructive" | "destructive-outline" | "outline" | "default";
  /** The dialog's confirming button; destructive unless the action is not (e.g. resuming). */
  confirmVariant?: "destructive" | "default";
  title: string;
  description: ReactNode;
  /** The dialog's confirming button, e.g. "Cancel run". */
  confirm: string;
  /** While it runs, e.g. "Canceling…". */
  busy: string;
  /** "Keep it". */
  keep: string;
  action: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await props.action();
      setOpen(false);
    } catch (e) {
      setError(toDataSourceError(e).message);
    }
    setBusy(false);
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(undefined);
      }}
    >
      <Button
        variant={props.variant ?? "outline"}
        size={props.size ?? "sm"}
        disabled={props.disabled}
        onClick={() => setOpen(true)}
      >
        {props.label}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{props.keep}</AlertDialogCancel>
          <Button variant={props.confirmVariant ?? "destructive"} disabled={busy} onClick={() => void run()}>
            {busy ? props.busy : props.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
