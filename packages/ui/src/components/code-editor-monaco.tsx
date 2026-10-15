/// <reference path="../worker.d.ts" />
// The Monaco half of CodeEditor, in its own module so it loads only when an editor opens. Monaco is bundled
// (loader.config({ monaco })), its worker too; only the editor core and the contributions a value editor
// needs are imported, and TypeScript's (the runner's custom test query, compiled by its worker). The colours come
// from the design tokens, per theme.
import type { CodeEditorProps } from "@bunvex/ui/components/code-editor";
import { parseOklch } from "@bunvex/ui/lib/contrast";
import { QUERY_COMPILER_OPTIONS } from "@bunvex/ui/lib/query-compiler-options";
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
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/typescript/register";
import {
  getTypeScriptWorker,
  ModuleKind,
  ScriptTarget,
  typescriptDefaults,
} from "monaco-editor/languages/features/typescript/register";
import TypeScriptWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === "typescript" ? new TypeScriptWorker() : new EditorWorker()),
};
loader.config({ monaco });

// ------------------------------------------------------------------ TypeScript (the runner's custom test query)

// A module of its own, compiled as Convex's runner compiles it; checked for syntax only — the app's types are not
// here, so a type error would be noise.
typescriptDefaults.setCompilerOptions({
  target: ScriptTarget.ES2020,
  module: ModuleKind.ESNext,
  allowNonTsExtensions: true,
});
typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });

/**
 * The files a typed editor is checked against (STUDY-162), as Convex's runner sets them up (`FunctionEditor.tsx`):
 * every one an extra lib, Convex's compiler options, and type errors underlined. Set again only when they change
 * (the deployment's schema).
 */
let typeFiles: Record<string, string> | null = null;
function installTypeFiles(files: Record<string, string> | undefined) {
  if (!files || files === typeFiles) return;
  typeFiles = files;
  typescriptDefaults.setCompilerOptions({ ...QUERY_COMPILER_OPTIONS, typeRoots: [] });
  typescriptDefaults.setExtraLibs(Object.entries(files).map(([filePath, content]) => ({ filePath, content })));
  typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
}

/**
 * Monaco's TypeScript worker, once its language is set up: the first TypeScript model sets it up asynchronously
 * (`onLanguage`), and asking before that fails ("TypeScript not registered!").
 */
async function typeScriptWorker() {
  for (let tries = 0; ; tries++) {
    try {
      return await getTypeScriptWorker();
    } catch (e) {
      if (tries >= 250) throw e;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

let compiled = 0;
/** `source` compiled by Monaco's TypeScript worker (Convex's `getEmitOutput`). */
export async function transpile(source: string): Promise<string> {
  const uri = monaco.Uri.parse(`file:///bunvex-transpile-${compiled++}.ts`);
  const model = monaco.editor.createModel(source, "typescript", uri);
  try {
    const client = await (await typeScriptWorker())(uri);
    const out = await client.getEmitOutput(uri.toString());
    return out.outputFiles[0]?.text ?? "";
  } finally {
    model.dispose();
  }
}

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
  const typed = props.language === "typescript" && props.typescript !== undefined;
  installTypeFiles(typed ? props.typescript!.files : undefined);
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

  // underline the error, with its message on hover: alone, from where it is to the end of its line; with more
  // errors or warnings, each one on the word it starts at (so one does not cover the next)
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    const e = props.error;
    const warnings = props.warnings ?? [];
    if (!e && warnings.length === 0) return monaco.editor.setModelMarkers(model, "bunvex", []);
    const at = (offset: number) => model.getPositionAt(Math.min(offset, Math.max(0, model.getValueLength() - 1)));
    const several = (props.moreErrors?.length ?? 0) > 0 || warnings.length > 0;
    const marker = (message: string, offset: number, severity = monaco.MarkerSeverity.Error) => {
      const start = at(offset);
      // a quoted value has no word at its quote: take the one after it, and the closing quote
      const word =
        model.getWordAtPosition(start) ??
        model.getWordAtPosition({ lineNumber: start.lineNumber, column: start.column + 1 });
      const wordEnd = word ? word.endColumn + (word.startColumn > start.column ? 1 : 0) : 0;
      const end = model.getPositionAt(model.getValueLength());
      const endColumn = several
        ? Math.max(wordEnd, start.column + 1)
        : end.lineNumber === start.lineNumber
          ? end.column
          : model.getLineMaxColumn(start.lineNumber);
      return {
        severity,
        message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: start.lineNumber,
        endColumn,
      };
    };
    monaco.editor.setModelMarkers(model, "bunvex", [
      ...(e ? [marker(e.message, e.offset ?? 0)] : []),
      ...(e ? (props.moreErrors ?? []) : []).map((m) => marker(m.message, m.offset)),
      ...warnings.map((w) => marker(w.message, w.offset, monaco.MarkerSeverity.Warning)),
    ]);
  }, [props.error, props.moreErrors, props.warnings]);

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
        language={props.language === "typescript" ? "typescript" : LANGUAGE}
        path={props.typescript?.path}
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
          // a typed editor completes as Convex's (its types' suggestions and parameter hints); a value editor does not
          quickSuggestions: typed ? { other: true, comments: false, strings: true } : false,
          suggestOnTriggerCharacters: typed,
          wordBasedSuggestions: "off",
          parameterHints: { enabled: typed },
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
