import { blob, CONFORMANCE, DRIVERS, FEATURES, SHIP } from "../content.ts";
import { Section } from "./section.tsx";

export function Features() {
  return (
    <Section id="features" kicker="Everything in one process" title="A database, a function runtime and a sync engine.">
      <ul className="m-0 grid list-none grid-cols-2 gap-3.5 p-0 lg:grid-cols-6">
        {FEATURES.map((f) => (
          <li
            key={f.tag}
            className={`col-span-2 flex min-w-0 flex-col gap-2.5 rounded-[14px] border border-line bg-surface p-[22px] ${
              "wide" in f ? "lg:col-span-4" : "half" in f ? "lg:col-span-3" : "lg:col-span-2"
            }`}
          >
            <span className={`font-mono text-[11.5px] ${"soon" in f ? "text-dim" : "text-violet"}`}>{f.tag}</span>
            <h3 className="font-display text-[19px] leading-tight font-semibold">
              <a href={blob(f.source)} className="hover:underline">
                {f.title}
              </a>
            </h3>
            <p className="text-[14.5px] text-soft">{f.body}</p>
            {"snippet" in f && (
              <code className="mt-auto block rounded-lg border border-line bg-page px-3 py-2.5 font-mono text-[12.5px] break-all">
                {f.snippet}
              </code>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Databases() {
  return (
    <Section
      id="databases"
      alt
      kicker="Persistence"
      title="Runs on the database you already operate."
      lede="The engine keeps every document version and index entry in an ordered store. Pick the store by configuration; your functions never change."
    >
      <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-5">
        {DRIVERS.map((d) => (
          <li key={d.name} className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-[18px]">
            <b className="font-mono text-base font-medium">{d.name}</b>
            <small className="text-[13px] text-dim">{d.note}</small>
            <span className="mt-2 font-mono text-xs text-good">✓ PERSIST-01</span>
          </li>
        ))}
      </ul>
      <ul className="m-0 mt-3.5 grid list-none gap-3 p-0 lg:grid-cols-3">
        {SHIP.map((s) => (
          <li
            key={s.command}
            className="rounded-xl border border-dashed border-line px-[18px] py-4 text-[14.5px] text-soft"
          >
            <code className="mb-1 block font-mono text-ink">{s.command}</code>
            {s.text}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[13.5px] text-dim">
        {CONFORMANCE.text}{" "}
        <a href={CONFORMANCE.link} className="text-soft underline underline-offset-4 hover:text-ink">
          Read the contract
        </a>
      </p>
    </Section>
  );
}
