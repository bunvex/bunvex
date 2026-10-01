// The Logs filter column (UI-01 §22.4), on the shared facet column (`shell/facet-column.tsx`): Time range
// (presets), Functions, Type and Function kind, each choice with how many loaded lines it holds (under the
// time range and the search). The Functions screen's column has Time range and Type only: its list is one
// function's. On a phone the same sections open in a sheet.
import type { FunctionKind } from "../data-source.ts";
import { FacetColumn, FacetGroup, FacetRadios } from "../shell/facet-column.tsx";
import {
  FUNCTION_KINDS,
  LOG_TYPES,
  type LogType,
  type LogView,
  RANGE_LABEL,
  RANGES,
  type RangePreset,
} from "./log-filter.ts";

export type Counts = {
  functions: Map<string, number>;
  kinds: Map<FunctionKind, number>;
  types: Map<LogType, number>;
};

export type FilterSectionsProps = {
  view: LogView;
  onView: (v: LogView) => void;
  counts: Counts;
  /** The functions to choose from (the Logs screen); none on one function's logs. */
  functions?: string[];
  /** Whether to offer the function kinds (the Logs screen). */
  kinds?: boolean;
};

const PRESETS = (["all", ...Object.keys(RANGES)] as (RangePreset | "all")[]).map((value) => ({
  value,
  label: RANGE_LABEL[value],
}));

/** The sections, in a column (wide screens) or a sheet (phones). */
export function FilterSections(props: FilterSectionsProps) {
  const { view, onView, counts } = props;
  return (
    <>
      <FacetRadios
        title="Time range"
        options={PRESETS}
        value={view.window ? undefined : view.range}
        onChange={(range) => onView({ ...view, range, window: undefined })}
        note={view.window && "A window picked on the histogram."}
      />
      {props.functions && (
        <FacetGroup
          title="Functions"
          options={props.functions}
          value={view.functions}
          counts={counts.functions}
          onChange={(functions) => onView({ ...view, functions })}
          mono
        />
      )}
      <FacetGroup<LogType>
        title="Type"
        options={LOG_TYPES}
        value={view.types}
        counts={counts.types}
        onChange={(types) => onView({ ...view, types })}
      />
      {props.kinds && (
        <FacetGroup<FunctionKind>
          title="Function kind"
          options={FUNCTION_KINDS}
          value={view.kinds}
          counts={counts.kinds}
          onChange={(kinds) => onView({ ...view, kinds })}
        />
      )}
    </>
  );
}

/** The column beside the list, from `md` (a phone gets the Filters sheet instead). */
export function FilterColumn(props: FilterSectionsProps & { widthKey: string; onReset?: () => void }) {
  return (
    <FacetColumn label="Log filters" widthKey={props.widthKey} onReset={props.onReset}>
      <FilterSections {...props} />
    </FacetColumn>
  );
}
