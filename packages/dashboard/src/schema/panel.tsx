// A table on the Schema screen (STUDY-12 §14), as Convex's `SchemaSidePanel.tsx`: every field with its type (a
// long one expands), a union's members one at a time with the field that picks them, the references in and out,
// and the table's indexes; Open in Database goes to its documents.
import { Badge } from "@bunvex/ui/components/badge";
import { Button, buttonVariants } from "@bunvex/ui/components/button";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { DashLink } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { Panel } from "../shell/panel.tsx";
import type { SchemaField, SchemaGraph, SchemaNode } from "./graph.ts";

function FieldRow({ field, discriminator }: { field: SchemaField; discriminator?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-start gap-2 font-mono text-xs">
        <span className="shrink-0 font-medium">
          {field.name}
          {field.optional && <span className="text-muted-foreground">?</span>}
        </span>
        {discriminator && (
          <Badge variant="secondary" title="Its value picks this member of the union.">
            discriminator
          </Badge>
        )}
        <span className="ml-auto min-w-0 text-right break-all text-muted-foreground">
          {open && field.fullType ? field.fullType : field.type}
        </span>
        {field.fullType && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={open ? `Collapse the type of ${field.name}` : `Expand the type of ${field.name}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </Button>
        )}
      </div>
    </li>
  );
}

export function TablePanel(props: {
  node: SchemaNode;
  graph: SchemaGraph;
  onOpen: (table: string) => void;
  onClose: () => void;
}) {
  const { node, graph } = props;
  const [variant, setVariant] = useState(0);
  const fields = node.union ? (node.union.variants[variant]?.fields ?? []) : node.fields;
  const out = [...new Set(graph.edges.filter((e) => e.source === node.table).map((e) => e.target))];
  const into = [...new Set(graph.edges.filter((e) => e.target === node.table).map((e) => e.source))];
  const refList = (tables: string[]) =>
    tables.map((t, i) => (
      <span key={t}>
        {i > 0 && ", "}
        <button type="button" className="font-mono underline-offset-2 hover:underline" onClick={() => props.onOpen(t)}>
          {t}
        </button>
      </span>
    ));

  return (
    <Panel title={<span className="font-mono">{node.table}</span>} onClose={props.onClose}>
      <div className="flex flex-col gap-5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <DashLink
            link={{ to: "/database/$table", params: { table: node.table } }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open in Database
          </DashLink>
          {node.documentCount !== undefined && (
            <span className="text-muted-foreground tabular-nums">{formatCount(node.documentCount)} documents</span>
          )}
        </div>
        {node.notInSchema && (
          <p className="text-muted-foreground">
            This table holds documents but is not declared in the schema; its fields are inferred from them.
          </p>
        )}

        <section aria-label="Fields" className="flex flex-col gap-2">
          <h3 className="font-medium">Fields</h3>
          {node.union && (
            <fieldset className="flex flex-wrap gap-1">
              <legend className="sr-only">Union members</legend>
              {node.union.variants.map((v, i) => (
                <Button
                  key={v.label}
                  variant={i === variant ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={i === variant}
                  className="font-mono"
                  onClick={() => setVariant(i)}
                >
                  {v.label}
                </Button>
              ))}
            </fieldset>
          )}
          {node.untyped ? (
            <p className="text-muted-foreground">No document type: any fields.</p>
          ) : fields.length === 0 ? (
            <p className="text-muted-foreground">This table has no fields.</p>
          ) : (
            <ul className="divide-y border">
              {fields.map((f) => (
                <FieldRow key={f.name} field={f} discriminator={node.union?.discriminator === f.name} />
              ))}
            </ul>
          )}
        </section>

        {(out.length > 0 || into.length > 0) && (
          <section aria-label="References" className="flex flex-col gap-1">
            <h3 className="font-medium">References</h3>
            {out.length > 0 && <p>Points at {refList(out)}</p>}
            {into.length > 0 && <p>Pointed at by {refList(into)}</p>}
          </section>
        )}

        <section aria-label="Indexes" className="flex flex-col gap-2">
          <h3 className="font-medium">Indexes</h3>
          {node.indexes.length === 0 ? (
            <p className="text-muted-foreground">None known for this table.</p>
          ) : (
            <ul className="divide-y border">
              {node.indexes.map((ix) => (
                <li key={ix.name} className="flex flex-col gap-1 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium">{ix.name}</span>
                    {ix.system && <Badge variant="secondary">system</Badge>}
                    {ix.state === "backfilling" && (
                      <Badge variant="outline" className="border-warning text-warning">
                        backfilling
                      </Badge>
                    )}
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">{ix.fields.join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Panel>
  );
}
