/** Where a command reads its environment and input and writes its output (tests pass their own). */
export type Io = {
  env: Record<string, string | undefined>;
  /** The project directory (default: the process's). */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Piped standard input, whole; null when it is a terminal (or absent). */
  stdin?: () => Promise<string | null>;
  /** Whether standard output is a terminal (values are then printed for people, not as JSON). */
  isTTY?: boolean;
  /** The terminal's width, when standard output is one (`bunvex data` cuts its table to it). */
  columns?: number;
  /** Ask the user on the terminal; null when there is none. */
  prompt?: (question: string) => string | null;
};

export const processIo = (): Io => ({
  env: process.env,
  cwd: process.cwd(),
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  isTTY: !!process.stdout.isTTY,
  columns: process.stdout.isTTY ? process.stdout.columns : undefined,
  stdin: async () => (process.stdin.isTTY ? null : await Bun.stdin.text()),
  prompt: (q) => (process.stdin.isTTY ? globalThis.prompt(q) : null),
});
