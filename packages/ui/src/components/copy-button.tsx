// Copies a text to the clipboard and says so — visibly and to screen readers — for two seconds. Next to a value
// it is an icon (`iconOnly`) named by `label` ("Copy client URL"), with the name and "Copied" as its tooltip;
// a page-level action keeps its text ("Copy all as .env").
import { Button } from "@bunvex/ui/components/button";
import { Check, Copy } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";

type CopyButtonProps = { text: string; label?: string; iconOnly?: boolean } & Omit<
  ComponentProps<typeof Button>,
  "onClick" | "children"
>;

function CopyButton({ text, label = "Copy", variant, size, iconOnly = false, ...rest }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  return (
    <>
      {iconOnly ? (
        <Button
          variant={variant ?? "ghost"}
          size={size ?? "icon-sm"}
          aria-label={label}
          title={state === "copied" ? "Copied" : label}
          onClick={copy}
          {...rest}
        >
          {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      ) : (
        <Button variant={variant ?? "outline"} size={size ?? "sm"} onClick={copy} {...rest}>
          {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {state === "copied" ? "Copied" : label}
        </Button>
      )}
      <span role="status" className="sr-only">
        {state === "copied" ? "Copied to the clipboard" : state === "failed" ? "Could not copy" : ""}
      </span>
    </>
  );
}

export { CopyButton };
