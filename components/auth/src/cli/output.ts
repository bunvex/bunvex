// The look of `bunx @bunvex/auth`'s output (STUDY-201 §1.18), v2's `cli/output.ts` without its libraries: every message
// is a bold section title, then indented lines that start with a status symbol. v2 colors with `chalk` and prints code
// with `@babel/code-frame`; bunvex writes the ANSI codes itself, so a code block has its dark panel but no syntax colors,
// and a `package.json` that does not parse shows the parser's message without a frame (DV-583).

/** Whether a stream shows colors: `FORCE_COLOR` turns them on (unless `0` or `false`), `NO_COLOR` off, else a terminal does. */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return isTTY && env.TERM !== "dumb";
}

const sgr = (open: string, close: string) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;
const ON = {
  bold: sgr("1", "22"),
  dim: sgr("2", "22"),
  red: sgr("31", "39"),
  green: sgr("32", "39"),
  yellow: sgr("33", "39"),
  cyan: sgr("36", "39"),
  // A dark gray background (the 256-color palette's 235).
  panel: sgr("48;5;235", "49"),
};
const OFF: typeof ON = {
  bold: (t) => t,
  dim: (t) => t,
  red: (t) => t,
  green: (t) => t,
  yellow: (t) => t,
  cyan: (t) => t,
  panel: (t) => t,
};

/** The spaces a code block keeps on each side of its code. */
const PADDING = 2;

/** The helpers that format the output, colored or not. */
export function makeOutput(color: boolean) {
  const c = color ? ON : OFF;
  return {
    bold: c.bold,
    dim: c.dim,
    cyan: c.cyan,
    // One character each, so the columns after them line up.
    symbols: { done: c.green("✔"), skipped: c.yellow("!"), failed: c.red("✖") },
    /** A section title, after an empty line. */
    heading: (title: string) => `\n${c.bold(title)}`,
    /** A status line in a section. */
    item: (symbol: string, text: string) => `  ${symbol} ${text}`,
    /** A shell command to run. */
    command: (text: string) => `    ${c.cyan(text)}`,
    /** A numbered step of the closing instructions. */
    step: (index: number, text: string) => `  ${c.dim(`${index}.`)} ${text}`,
    /**
     * Code to copy, with no line numbers, so selecting it gives back the code alone. In color, it sits on a dark panel as
     * wide as its longest line, with two spaces on each side and an empty row above and below; without, as it is.
     */
    codeBlock(code: string): string {
      const lines = code.replace(/\n+$/, "").split("\n");
      if (!color) return lines.join("\n");
      const width = Math.max(...lines.map((line) => line.length)) + 2 * PADDING;
      const row = (text: string) => c.panel(" ".repeat(PADDING) + text.padEnd(width - PADDING));
      return [row(""), ...lines.map(row), row("")].join("\n");
    },
  };
}

export type Output = ReturnType<typeof makeOutput>;
