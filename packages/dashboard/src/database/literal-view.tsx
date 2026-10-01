// A value as the JavaScript literal the rest of the dashboard writes (STUDY-12 D9: `credits: 10n`,
// `Bytes("…")`, bare keys), pretty-printed with its types told apart by colour — the colours of `JsonView`,
// whose contrast is tested. For the document panel (UX-1): the same notation as the cells and editors.
import { cn } from "@bunvex/ui/lib/utils";
import type { ReactNode } from "react";
import type { Value } from "../data-source.ts";
import { decodeInt64, valueType } from "../filters.ts";

const INDENT = "  ";
const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function render(v: Value, depth: number): ReactNode {
  const pad = INDENT.repeat(depth + 1);
  const end = INDENT.repeat(depth);
  switch (valueType(v)) {
    case "null":
    case "boolean":
      return <span className="text-warning">{String(v)}</span>;
    case "number":
      return <span className="text-info">{JSON.stringify(v)}</span>;
    case "int64":
      return <span className="text-info">{`${decodeInt64(v as { $integer: string })}n`}</span>;
    case "bytes":
      return <span className="text-success">{`Bytes(${JSON.stringify((v as { $bytes: string }).$bytes)})`}</span>;
    case "string":
      return <span className="text-success">{JSON.stringify(v)}</span>;
    case "array": {
      const xs = v as Value[];
      if (xs.length === 0) return "[]";
      return (
        <>
          {"[\n"}
          {xs.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: array positions are the identity here
            <span key={i}>
              {pad}
              {render(x, depth + 1)}
              {",\n"}
            </span>
          ))}
          {`${end}]`}
        </>
      );
    }
    default: {
      const entries = Object.entries(v as Record<string, Value>);
      if (entries.length === 0) return "{}";
      return (
        <>
          {"{\n"}
          {entries.map(([k, x]) => (
            <span key={k}>
              {pad}
              <span className="font-medium text-foreground">{KEY.test(k) ? k : JSON.stringify(k)}</span>
              {": "}
              {render(x, depth + 1)}
              {",\n"}
            </span>
          ))}
          {`${end}}`}
        </>
      );
    }
  }
}

export function LiteralView({ value, className, label }: { value: Value; className?: string; label?: string }) {
  return (
    <figure data-slot="literal-view" aria-label={label} className={cn("m-0 min-w-0", className)}>
      <pre className="overflow-x-auto border bg-muted/40 p-4 font-mono text-sm leading-relaxed text-muted-foreground">
        <code>{render(value, 0)}</code>
      </pre>
    </figure>
  );
}
