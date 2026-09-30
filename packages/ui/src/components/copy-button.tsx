// Copies a text to the clipboard and says so — visibly and to screen readers — for two seconds.
import { Button } from "@bunvex/ui/components/button";
import { Check, Copy } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";

type CopyButtonProps = { text: string; label?: string } & Omit<ComponentProps<typeof Button>, "onClick" | "children">;

function CopyButton({ text, label = "Copy", variant = "outline", size = "sm", ...rest }: CopyButtonProps) {
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
      <Button variant={variant} size={size} onClick={copy} {...rest}>
        {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {state === "copied" ? "Copied" : label}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied" ? "Copied to the clipboard" : state === "failed" ? "Could not copy" : ""}
      </span>
    </>
  );
}

export { CopyButton };
