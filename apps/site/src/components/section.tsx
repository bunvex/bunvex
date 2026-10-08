import type { ReactNode } from "react";

/** A landing section: a labelled band with a kicker, an h2 and an optional lede, on the page's column. */
export function Section({
  id,
  kicker,
  title,
  lede,
  alt = false,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  lede?: string;
  alt?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`scroll-mt-16 border-t border-line ${alt ? "bg-band" : ""}`}
    >
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
        <div className="mb-10 flex max-w-3xl flex-col gap-3.5">
          <p className="font-mono text-xs tracking-[0.08em] text-honey uppercase">{kicker}</p>
          <h2
            id={`${id}-title`}
            className="font-display text-3xl leading-[1.05] font-extrabold tracking-tight text-balance sm:text-5xl"
          >
            {title}
          </h2>
          {lede && <p className="max-w-[58ch] text-lg text-soft">{lede}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

/** A button-styled link: honey (primary) or outlined. */
export function CtaLink({ href, primary = false, children }: { href: string; primary?: boolean; children: ReactNode }) {
  return (
    <a
      href={href}
      className={`inline-flex items-center gap-2 rounded-[10px] border px-[18px] py-[11px] text-[15px] font-semibold no-underline transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-honey ${
        primary ? "border-honey bg-honey text-honey-ink" : "border-line text-ink"
      }`}
    >
      {children}
    </a>
  );
}
