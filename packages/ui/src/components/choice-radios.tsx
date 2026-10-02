// A single choice shown as radio buttons, in the design system's RadioGroup: a labelled group, each option
// a clickable label.
import { RadioGroup, RadioGroupItem } from "@bunvex/ui/components/radio-group";
import { cn } from "@bunvex/ui/lib/utils";
import { useId } from "react";

export function ChoiceRadios<T extends string>(props: {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  className?: string;
  /** The group label's classes, to match the form's other labels. */
  labelClassName?: string;
  /** Options on one row instead of a column. */
  inline?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", props.className)}>
      <span id={`${id}-label`} className={props.labelClassName ?? "text-sm font-medium"}>
        {props.label}
      </span>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={props.value}
        onValueChange={(v) => props.onValueChange(v as T)}
        className={props.inline ? "flex flex-wrap gap-x-4 gap-y-1.5" : "gap-1.5"}
      >
        {props.options.map((o) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: the radio (a button with role="radio") is inside the label
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <RadioGroupItem value={o.value} disabled={o.disabled} />
            {o.label}
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}
