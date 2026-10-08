import { blob, NOTICE, SITE } from "../content.ts";

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-[13.5px] text-dim sm:px-6 md:flex-row md:justify-between">
        <p className="max-w-xl">{NOTICE}</p>
        <p className="flex gap-5">
          <a href={blob("LICENSE")} className="hover:text-ink hover:underline">
            Apache-2.0
          </a>
          <a href={SITE.repo} className="hover:text-ink hover:underline">
            GitHub
          </a>
        </p>
      </div>
    </footer>
  );
}
