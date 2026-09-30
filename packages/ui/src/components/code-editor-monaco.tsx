/// <reference path="../worker.d.ts" />
// The Monaco half of CodeEditor, in its own module so it loads only when an editor opens. Monaco is bundled
// (loader.config({ monaco })), its worker too; only the editor core and the contributions a value editor
// needs are imported — no language services. The colours come from the design tokens, per theme.
import type { CodeEditorProps } from "@bunvex/ui/components/code-editor";
import { parseOklch } from "@bunvex/ui/lib/contrast";
import { cn } from "@bunvex/ui/lib/utils";
import MonacoReact, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/browser/coreCommands";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// ------------------------------------------------------------------ the language: JavaScript literals

const LANGUAGE = "bunvex-literal";
monaco.languages.register({ id: LANGUAGE });
monaco.languages.setLanguageConfiguration(LANGUAGE, {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string"] },
  ],
});
monaco.languages.setMonarchTokensProvider(LANGUAGE, {
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/'(?:[^'\\]|\\.)*'/, "string"],
      [/["'].*$/, "string.invalid"],
      [/-?\d+n\b/, "number"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null|undefined)\b/, "keyword"],
      [/\bBytes\b/, "type"],
      [/[A-Za-z_$][\w$]*(?=\s*:)/, "key"],
      [/[A-Za-z_$][\w$]*/, "invalid"],
      [/[{}[\]()]/, "@brackets"],
      [/[,:]/, "delimiter"],
    ],
    comment: [
      [/[^*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/\*/, "comment"],
    ],
  },
});

// ------------------------------------------------------------------ themes from the design tokens

function hex(cssColor: string): string {
  const c = parseOklch(cssColor.trim());
  const b = (x: number) =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${b(c.r)}${b(c.g)}${b(c.b)}${c.a < 1 ? b(c.a) : ""}`;
}

/** Defines the theme for the current light / dark tokens and returns its name. */
function defineTheme(): string {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => hex(css.getPropertyValue(`--${name}`) || "oklch(0.5 0 0)");
  const dark = document.documentElement.classList.contains("dark");
  const name = dark ? "bunvex-dark" : "bunvex-light";
  const fg = (t: string) => token(t).slice(1, 7);
  monaco.editor.defineTheme(name, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "string", foreground: fg("success") },
      { token: "number", foreground: fg("info") },
      { token: "keyword", foreground: fg("warning") },
      { token: "type", foreground: fg("warning") },
      { token: "key", foreground: fg("foreground") },
      { token: "comment", foreground: fg("muted-foreground"), fontStyle: "italic" },
      { token: "delimiter", foreground: fg("muted-foreground") },
      { token: "invalid", foreground: fg("destructive") },
      { token: "string.invalid", foreground: fg("destructive") },
    ],
    colors: {
      "editor.background": token("background"),
      "editor.foreground": token("foreground"),
      "editorCursor.foreground": token("foreground"),
      "editor.lineHighlightBackground": token("muted"),
      "editor.selectionBackground": `${token("ring").slice(0, 7)}55`,
      "editorLineNumber.foreground": token("muted-foreground"),
      "editorError.foreground": token("destructive"),
      focusBorder: token("ring"),
    },
  });
  return name;
}

/** The theme's name, redefined whenever the page switches between light and dark. */
function useTheme(): string {
  const [theme, setTheme] = useState(defineTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(defineTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

// ------------------------------------------------------------------ the editor

export default function CodeEditorMonaco(props: CodeEditorProps) {
  const theme = useTheme();
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // Monaco holds the text; the caller's `value` follows it. Controlling it (`value=`) lost keystrokes:
  // typing faster than React re-renders handed Monaco an older value, which replaced the newer text. So
  // the text is written back only when `value` changes from outside — not when it is the echo of
  // something typed, however late that echo arrives.
  const echoes = useRef<string[]>([]);
  const emit = (text: string) => {
    echoes.current.push(text);
    latest.current.onChange(text);
  };
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const echo = echoes.current.indexOf(props.value);
    if (echo >= 0) {
      echoes.current.splice(0, echo + 1);
      return;
    }
    echoes.current = [];
    if (editor.getValue() !== props.value) editor.setValue(props.value);
  }, [props.value]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    const K = monaco.KeyCode;
    const noWidget = "!findWidgetVisible && !suggestWidgetVisible";
    // a key right after typing can come before React has rendered the last keystroke: render it first,
    // so the caller's handler reads the text as it is
    const settled = (run: () => void) => () => {
      const text = editor.getValue();
      flushSync(() => emit(text));
      run();
    };
    editor.addCommand(K.Escape, () => latest.current.onCancel?.(), noWidget);
    if (latest.current.multiline) {
      // Cmd+Enter on a Mac, Ctrl+Enter everywhere (as the hints say, and as the plain field does)
      const submit = settled(() => latest.current.onSubmit?.());
      editor.addCommand(monaco.KeyMod.CtrlCmd | K.Enter, submit);
      editor.addCommand(monaco.KeyMod.WinCtrl | K.Enter, submit);
    } else {
      editor.addCommand(
        K.Enter,
        settled(() => latest.current.onSubmit?.()),
      );
      if (latest.current.onTab)
        editor.addCommand(
          K.Tab,
          settled(() => latest.current.onTab?.()),
        );
    }
    if (latest.current.autoFocus) {
      editor.focus();
      const model = editor.getModel();
      if (model) editor.setPosition(model.getPositionAt(model.getValueLength()));
    }
  };

  // underline the error, with its message on hover
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    const e = props.error;
    if (!e) return monaco.editor.setModelMarkers(model, "bunvex", []);
    const start = model.getPositionAt(Math.min(e.offset ?? 0, Math.max(0, model.getValueLength() - 1)));
    const end = model.getPositionAt(model.getValueLength());
    const sameLine = end.lineNumber === start.lineNumber;
    monaco.editor.setModelMarkers(model, "bunvex", [
      {
        severity: monaco.MarkerSeverity.Error,
        message: e.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: start.lineNumber,
        endColumn: sameLine ? end.column : model.getLineMaxColumn(start.lineNumber),
      },
    ]);
  }, [props.error]);

  const single = !props.multiline;
  return (
    <div
      data-slot="code-editor"
      className={cn(
        "overflow-hidden border border-input bg-background focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50",
        single && "h-7",
        props.error && "border-destructive",
        props.className,
      )}
      style={single ? undefined : { height: props.height ?? 240 }}
    >
      <MonacoReact
        defaultValue={props.value}
        onChange={(v) => {
          const text = v ?? "";
          // one line: a pasted line break becomes a space, in the editor too
          if (single && /[\r\n]/.test(text)) {
            editorRef.current?.setValue(text.replace(/\r?\n/g, " "));
            return;
          }
          emit(text);
        }}
        onMount={onMount}
        language={LANGUAGE}
        theme={theme}
        loading={null}
        options={{
          ariaLabel: props.label,
          accessibilitySupport: "auto",
          placeholder: props.placeholder,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          renderLineHighlight: single ? "none" : "line",
          lineNumbers: single ? "off" : "on",
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: !single,
          lineDecorationsWidth: single ? 6 : 8,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          wordWrap: single ? "off" : "on",
          scrollbar: single
            ? { vertical: "hidden", horizontal: "hidden", alwaysConsumeMouseWheel: false }
            : { alwaysConsumeMouseWheel: false },
          fixedOverflowWidgets: true,
          quickSuggestions: false,
          suggestOnTriggerCharacters: false,
          wordBasedSuggestions: "off",
          parameterHints: { enabled: false },
          contextmenu: false,
          // one line: Tab leaves the field (unless the caller takes it); several: Ctrl+M toggles it
          tabFocusMode: single && !props.onTab,
          padding: single ? { top: 5, bottom: 5 } : { top: 8, bottom: 8 },
          tabSize: 2,
        }}
      />
    </div>
  );
}
