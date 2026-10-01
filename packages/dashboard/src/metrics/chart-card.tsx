// A metrics chart in a card: its title, what it measures, and the chart — or why there is none (loading,
// an error, not allowed).
import { type ChartSeries, LineChart } from "@bunvex/ui/components/line-chart";
import { Skeleton } from "@bunvex/ui/components/skeleton";
import { toDataSourceError } from "../data-source.ts";

export function ChartCard(props: {
  title: string;
  description: string;
  series: ChartSeries[] | undefined;
  error?: unknown;
  formatValue?: (v: number) => string;
  max?: number;
  directLabels?: boolean;
  empty?: string;
}) {
  const id = `chart-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3 border p-4">
      <div>
        <h3 id={id} className="text-sm font-medium">
          {props.title}
        </h3>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load: {toDataSourceError(props.error).message}
        </p>
      ) : props.series ? (
        <LineChart
          label={`${props.title}, ${props.description}`}
          series={props.series}
          formatValue={props.formatValue}
          max={props.max}
          directLabels={props.directLabels}
          empty={props.empty}
        />
      ) : (
        <Skeleton className="h-[180px]" />
      )}
    </section>
  );
}
