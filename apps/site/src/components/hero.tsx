import { useState } from "react";
import { EXAMPLES, HERO, INSTALL, parityPercent, SITE } from "../content.ts";
import { LiveDemo } from "./live-demo.tsx";
import { CtaLink } from "./section.tsx";
import { Tabs } from "./tabs.tsx";

export function Hero() {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-14 pb-16 sm:px-6 md:pt-16 md:pb-20">
      <a
        href="#status"
        className="inline-flex items-center gap-2.5 rounded-full border border-line py-1 pr-3.5 pl-1.5 text-[13.5px] text-soft no-underline hover:text-ink"
      >
        <span className="rounded-full bg-violet px-2 py-px text-xs font-semibold whitespace-nowrap text-honey-ink">
          pre-alpha
        </span>
        {parityPercent()}% {HERO.pill}
      </a>
      <div className="mt-7 grid items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
        <div className="min-w-0">
          <h1 className="font-display text-[clamp(42px,6.4vw,76px)] leading-[1.02] font-extrabold tracking-tight text-balance">
            {HERO.headline[0]} <span className="text-honey">{HERO.headline[1]}</span>
          </h1>
          <p className="mt-6 max-w-[58ch] text-lg text-soft">{HERO.subline}</p>
          <Install />
          <div className="mt-6 flex flex-wrap gap-3">
            <CtaLink href={EXAMPLES} primary>
              Try an example →
            </CtaLink>
            <CtaLink href={SITE.repo}>★ Star on GitHub</CtaLink>
          </div>
        </div>
        <LiveDemo />
      </div>
    </div>
  );
}

function Install() {
  return (
    <Tabs
      label="Install"
      className="mt-8 max-w-[540px] overflow-hidden rounded-xl border border-line bg-surface"
      listClassName="flex border-b border-line text-[13px]"
      tabClassName={(on) =>
        `border-b-2 px-3.5 py-2 ${on ? "border-honey text-ink" : "border-transparent text-dim hover:text-soft"}`
      }
      tabs={INSTALL.map((i) => ({ id: i.id, label: i.label, panel: <Commands lines={i.lines} /> }))}
    />
  );
}

function Commands({ lines }: { lines: readonly string[] }) {
  const [copied, setCopied] = useState<"" | "copied" | "select the text">("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied("copied");
    } catch {
      setCopied("select the text");
    }
  }
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3.5">
      <pre className="m-0 min-w-0 font-mono text-sm leading-[1.75] break-all whitespace-pre-wrap">
        {lines.map((l) => (
          <span key={l} className="block">
            <span aria-hidden="true" className="text-dim select-none">
              ${" "}
            </span>
            {l}
          </span>
        ))}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-line px-2.5 py-0.5 text-xs text-soft hover:text-ink"
      >
        {copied || "copy"}
      </button>
    </div>
  );
}
