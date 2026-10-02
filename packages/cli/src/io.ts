/** Where a command reads its environment and writes its output (tests pass their own). */
export type Io = {
  env: Record<string, string | undefined>;
  /** The project directory (default: the process's). */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

export const processIo = (): Io => ({
  env: process.env,
  cwd: process.cwd(),
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
});
