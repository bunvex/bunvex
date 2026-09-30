import { CODE } from "../content.ts";
import { Section } from "./section.tsx";

export function CodeSample() {
  return (
    <Section id="code" title="The API you already know">
      <p className="max-w-2xl text-muted-foreground">{CODE.label}</p>
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {CODE.files.map((f) => (
          <figure key={f.name} className="min-w-0 border border-border bg-card">
            <figcaption className="border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
              {f.name}
            </figcaption>
            {/* wraps instead of scrolling: a scrolling <pre> would have to be keyboard-focusable (axe
                scrollable-region-focusable) */}
            <pre className="p-4 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">
              <code>{f.code}</code>
            </pre>
          </figure>
        ))}
      </div>
    </Section>
  );
}
