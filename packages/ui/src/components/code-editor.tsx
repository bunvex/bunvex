// A small code editor for values (UI-01 §12.5.7): Monaco, loaded on demand and bundled (no CDN, so a
// self-hosted dashboard works offline), with a language of its own for JavaScript literals. One line for a
// value box (Enter submits, Escape cancels, Tab leaves or `onTab`), several for a document (Ctrl/Cmd+Enter
// submits). Until Monaco has loaded — and where it cannot run, like tests — a plain field with the same
// keys stands in.
import { cn } from "@bunvex/ui/lib/utils";
import { type KeyboardEvent, lazy, Suspense, useRef } from "react";

export type CodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name. */
  label: string;
  /** Several lines (a document) instead of one (a value). */
  multiline?: boolean;
  /** Enter (one line) or Ctrl/Cmd+Enter (several). */
  onSubmit?: () => void;
  /** Escape. */
  onCancel?: () => void;
  /** One line only: Tab calls this instead of leaving the field (e.g. "save and move right"). */
  onTab?: () => void;
  /** Where the text stops making sense, and why: underlined from there, the message on hover. */
  error?: { message: string; offset?: number };
  /** More problems to underline, each at its offset (the field's message stays `error`'s). */
  moreErrors?: { message: string; offset: number }[];
  /** Ids of elements that describe the field (a hint, the error text). */
  describedBy?: string;
  autoFocus?: boolean;
  placeholder?: string;
  /** Several lines: the editor's height in px. Default 240. */
  height?: number;
  className?: string;
};

let implementation: "monaco" | "plain" = "monaco";
/** Where Monaco cannot run (tests without layout), use the plain field everywhere. */
export function setCodeEditorImplementation(impl: "monaco" | "plain") {
  implementation = impl;
}

const loadMonaco = () => import("@bunvex/ui/components/code-editor-monaco");
const MonacoEditor = lazy(loadMonaco);
/** Start loading Monaco before the first editor opens (e.g. when a screen that has editors mounts). */
export const preloadCodeEditor = () => {
  if (implementation === "monaco") void loadMonaco();
};

function CodeEditor(props: CodeEditorProps) {
  if (implementation === "plain") return <PlainEditor {...props} />;
  return (
    <Suspense fallback={<PlainEditor {...props} />}>
      <MonacoEditor {...props} />
    </Suspense>
  );
}

/** A textarea (or an input) with the editor's keys. */
function PlainEditor(props: CodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && props.onCancel) {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    } else if (e.key === "Enter" && props.onSubmit && (props.multiline ? e.ctrlKey || e.metaKey : true)) {
      e.preventDefault();
      props.onSubmit();
    } else if (e.key === "Tab" && !e.shiftKey && !props.multiline && props.onTab) {
      e.preventDefault();
      props.onTab();
    }
  };
  const shared = {
    ref,
    "aria-label": props.label,
    "aria-invalid": props.error ? true : undefined,
    "aria-describedby": props.describedBy,
    autoFocus: props.autoFocus,
    placeholder: props.placeholder,
    spellCheck: false,
    value: props.value,
    onKeyDown,
    "data-slot": "code-editor",
  };
  // the caller's classes come last: they win (a cell editor fills its cell)
  const classes = (base: string) =>
    cn(
      "w-full border border-input bg-background px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50",
      base,
      props.error && "border-destructive",
      props.className,
    );
  return props.multiline ? (
    <textarea
      {...shared}
      style={{ height: props.height ?? 240 }}
      className={classes("resize-y py-2")}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ) : (
    <input {...shared} className={classes("h-7")} onChange={(e) => props.onChange(e.target.value)} />
  );
}

export { CodeEditor };
