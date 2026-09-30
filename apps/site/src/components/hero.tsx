import { Badge } from "@bunvex/ui/components/badge";
import { buttonVariants } from "@bunvex/ui/components/button";
import { Star } from "lucide-react";
import { HERO, SITE } from "../content.ts";

export function Hero() {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-16 pb-20 sm:px-6 md:pt-28 md:pb-32">
      <Badge variant="outline">pre-alpha</Badge>
      <h1 className="mt-6 max-w-4xl font-mono text-4xl leading-[1.05] font-bold tracking-tight text-balance sm:text-6xl">
        {HERO.headline}
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">{HERO.subline}</p>
      <div className="mt-10 flex flex-wrap gap-3">
        <a href={SITE.repo} className={buttonVariants({ size: "lg" })}>
          <Star aria-hidden="true" />
          Star on GitHub
        </a>
        <a href="#benchmarks" className={buttonVariants({ size: "lg", variant: "outline" })}>
          See the benchmarks
        </a>
      </div>
    </div>
  );
}
