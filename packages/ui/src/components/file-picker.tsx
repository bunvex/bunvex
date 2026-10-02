// Picking a file in the design system's look, never the browser's "Choose File": a button, the chosen
// file's name, and a zone that also takes a dropped file. The real <input type="file"> stays (hidden) for
// the file dialog and for tests.
import { Button } from "@bunvex/ui/components/button";
import { cn } from "@bunvex/ui/lib/utils";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";

export function FilePicker(props: {
  id?: string;
  /** The file input's accessible name. */
  label: string;
  accept?: string;
  file: File | null;
  onFile: (file: File | null) => void;
  /** Shown before a file is picked. */
  hint?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop zone is an extra path; the button picks
    <div
      data-slot="file-picker"
      data-over={over || undefined}
      className={cn(
        "flex flex-wrap items-center gap-3 border border-dashed px-3 py-3 text-sm data-[over]:border-ring data-[over]:bg-muted/40",
        props.className,
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        props.onFile(e.dataTransfer.files[0] ?? null);
      }}
    >
      <input
        ref={input}
        id={props.id}
        type="file"
        hidden
        accept={props.accept}
        aria-label={props.label}
        onChange={(e) => props.onFile(e.target.files?.[0] ?? null)}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
        <Upload aria-hidden="true" />
        {props.file ? "Choose another file" : "Choose a file"}
      </Button>
      <span className={cn("min-w-0 truncate", props.file ? "font-mono" : "text-muted-foreground")}>
        {props.file ? props.file.name : (props.hint ?? "or drop one here")}
      </span>
    </div>
  );
}
