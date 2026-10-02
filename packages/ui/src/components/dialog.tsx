// A modal dialog on Base UI's Dialog (focus trapped, Escape and the backdrop close it, focus returns to
// what opened it). Used by the dashboard's command palette.
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@bunvex/ui/lib/utils";

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogContent({ className, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/20 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-[12svh] left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col bg-popover text-popover-foreground ring-1 ring-foreground/10 shadow-lg outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none",
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-sm font-medium", className)} {...props} />;
}

export { Dialog, DialogContent, DialogTitle };
