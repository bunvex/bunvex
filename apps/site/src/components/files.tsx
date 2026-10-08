import { blob, FILES } from "../content.ts";
import { Code } from "./code.tsx";
import { Section } from "./section.tsx";
import { Tabs } from "./tabs.tsx";

export function Files() {
  return (
    <Section
      id="code"
      alt
      kicker="The whole backend"
      title="Two files to a live, multi-user app."
      lede="The functions and the component of the tutorial example: open it in two tabs and they chat. A schema is optional; add one and every write is validated."
    >
      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Tabs
          label="Files"
          className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface"
          listClassName="flex border-b border-line"
          tabClassName={(on) =>
            `border-r border-line px-4 py-2.5 font-mono text-[13px] ${on ? "bg-band text-ink shadow-[inset_0_-2px_0_var(--color-honey)]" : "text-dim hover:text-soft"}`
          }
          tabs={FILES.files.map((f) => ({
            id: f.name,
            label: f.name,
            panel: (
              <>
                <Code code={f.code} className="min-h-[330px] p-[18px] text-[13.5px] leading-[1.7]" />
                <p className="border-t border-line px-[18px] py-2 text-xs text-dim">
                  <a href={blob(f.path)} className="hover:text-soft">
                    {f.path}
                  </a>
                  {f.whole ? "" : " (some lines left out)"}
                </p>
              </>
            ),
          }))}
        />
        <div className="flex flex-col">
          <h3 className="mb-2.5 font-display text-xl font-semibold">What you did not write</h3>
          <ul className="m-0 list-none p-0">
            {FILES.notWritten.map((n) => (
              <li key={n.gone} className="grid grid-cols-[22px_1fr] gap-2.5 border-b border-line py-2.5 text-[15px]">
                <span aria-hidden="true" className="font-mono text-good">
                  ✓
                </span>
                <span>
                  <a href={blob(n.source)} className="text-dim line-through decoration-bad hover:text-soft">
                    {n.gone}
                  </a>{" "}
                  {n.note}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
