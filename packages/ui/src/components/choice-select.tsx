// A single choice from a short list of options, in the design system's Select (never the browser's
// <select>, whose chrome ignores the theme). `id` names the trigger, so a <label htmlFor> labels it.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";

export type ChoiceOption<T extends string> = { value: T; label: string; disabled?: boolean };

export function ChoiceSelect<T extends string>(props: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly ChoiceOption<T>[];
  id?: string;
  className?: string;
  size?: "sm" | "default";
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <Select
      items={props.options.map((o) => ({ value: o.value, label: o.label }))}
      value={props.value}
      onValueChange={(v) => props.onValueChange(v as T)}
      disabled={props.disabled}
    >
      <SelectTrigger
        id={props.id}
        size={props.size}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        className={props.className}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
