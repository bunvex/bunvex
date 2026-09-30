// A JSON value, pretty-printed with its types told apart by colour (and by syntax, for readers who do not
// see the colour). Each colour is a token whose contrast on the background is tested.
import { cn } from "@bunvex/ui/lib/utils";
import type { ReactNode } from "react";

const INDENT = "  ";

function render(value: unknown, depth: number): ReactNode {
  if (value === null) return <span className="text-warning">null</span>;
  if (typeof value === "boolean") return <span className="text-warning">{String(value)}</span>;
  if (typeof value === "number") return <span className="text-info">{String(value)}</span>;
  if (typeof value === "string") return <span className="text-success">{JSON.stringify(value)}</span>;
  const pad = INDENT.repeat(depth + 1);
  const end = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return (
      <>
        {"[\n"}
        {value.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: array positions are the identity here
          <span key={i}>
            {pad}
            {render(v, depth + 1)}
            {i < value.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {`${end}]`}
      </>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return (
      <>
        {"{\n"}
        {entries.map(([k, v], i) => (
          <span key={k}>
            {pad}
            <span className="font-medium text-foreground">{JSON.stringify(k)}</span>
            {": "}
            {render(v, depth + 1)}
            {i < entries.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {`${end}}`}
      </>
    );
  }
  return <span className="text-muted-foreground">{String(value)}</span>;
}

function JsonView({ value, className, label }: { value: unknown; className?: string; label?: string }) {
  return (
    <figure data-slot="json-view" aria-label={label} className={cn("m-0", className)}>
      <pre className="overflow-auto border bg-muted/40 p-4 font-mono text-sm leading-relaxed text-muted-foreground">
        <code>{render(value, 0)}</code>
      </pre>
    </figure>
  );
}

export { JsonView };
