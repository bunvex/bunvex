import type { ReactNode } from "react";

const TOKENS = /(\/\/[^\n]*|\/\*\*[^\n]*\*\/)|("[^"\n]*")|\b(import|from|export|const|async|await|return|function)\b/g;

/** A small highlighter for the TypeScript samples: comments, strings and keywords. */
export function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of code.matchAll(TOKENS)) {
    if (m.index > at) out.push(code.slice(at, m.index));
    const cls = m[1] ? "tok-c" : m[2] ? "tok-s" : "tok-k";
    out.push(
      <span key={m.index} className={cls}>
        {m[0]}
      </span>,
    );
    at = m.index + m[0].length;
  }
  if (at < code.length) out.push(code.slice(at));
  return out;
}

/** A code block that wraps rather than scrolls, so no unfocusable scroll region exists at any width. */
export function Code({ code, className = "" }: { code: string; className?: string }) {
  return <pre className={`m-0 font-mono whitespace-pre-wrap ${className}`}>{highlight(code)}</pre>;
}
