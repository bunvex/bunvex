// Argument errors as Convex's CLI prints them (STUDY-124): Convex parses its arguments with commander 14, whose
// `Command.error` writes `error: <message>` to stderr — then, for the commands Convex built with
// `showHelpAfterError()`, an empty line and the command's help — and exits with code 1. The messages below are
// commander's (lib/command.js), with its "Did you mean …?" suggestions (lib/suggestSimilar.js).
import type { Io } from "./io.ts";

/** Print an argument error as commander does; resolves the command's exit code (1). */
export function argumentError(io: Io, message: string, help?: string): number {
  io.err(`error: ${message}`);
  if (help !== undefined) {
    io.err("");
    io.err(help);
  }
  return 1;
}

/** A thrown argument error, for parsers that return through several calls. */
export class ArgumentError extends Error {}

export const missingArgument = (spec: string) => `option '${spec}' argument missing`;
export const invalidArgument = (spec: string, value: string, reason: string) =>
  `option '${spec}' argument '${value}' is invalid. ${reason}`;
export const invalidChoice = (spec: string, value: string, choices: readonly string[]) =>
  invalidArgument(spec, value, `Allowed choices are ${choices.join(", ")}.`);
export const requiredOption = (spec: string) => `required option '${spec}' not specified`;
export const missingRequiredArgument = (name: string) => `missing required argument '${name}'`;
export const conflictingOptions = (a: string, b: string) => `option '${a}' cannot be used with option '${b}'`;
/** `subcommand`: the command's name when it is not the program itself (commander's `for '<name>'`). */
export const tooManyArguments = (subcommand: string | null, expected: number, received: number) =>
  `too many arguments${subcommand ? ` for '${subcommand}'` : ""}. Expected ${expected} argument${expected === 1 ? "" : "s"} but got ${received}.`;

/** The long options a command's help lists (and `--help`): what commander suggests from. */
export const optionsIn = (help: string) => [...new Set([...(help.match(/--[a-z][\w-]*/g) ?? []), "--help"])];
export const unknownOption = (flag: string, candidates: string[]) =>
  `unknown option '${flag}'${flag.startsWith("--") ? suggestSimilar(flag, candidates) : ""}`;
export const unknownCommand = (name: string, candidates: string[]) =>
  `unknown command '${name}'${suggestSimilar(name, candidates)}`;

/** Commander's optimal-string-alignment distance (Damerau–Levenshtein without repeated edits), capped at 3. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return Math.max(a.length, b.length);
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2]! + 1);
      row.push(d);
    }
    before = previous;
    previous = row;
  }
  return previous[b.length]!;
}

/**
 * Commander's suggestion: the candidates closest to `word` (at most 3 edits, more than 40% alike, none of one
 * character), sorted; `--` is ignored when comparing options.
 */
export function suggestSimilar(word: string, candidates: string[]): string {
  const options = word.startsWith("--");
  const strip = (s: string) => (options ? s.slice(2) : s);
  const target = strip(word);
  let best = 3;
  let similar: string[] = [];
  for (const candidate of new Set(candidates.map(strip))) {
    if (candidate.length <= 1) continue;
    const distance = editDistance(target, candidate);
    const length = Math.max(target.length, candidate.length);
    if ((length - distance) / length <= 0.4) continue;
    if (distance < best) {
      best = distance;
      similar = [candidate];
    } else if (distance === best) similar.push(candidate);
  }
  similar.sort((x, y) => x.localeCompare(y));
  const named = similar.map((c) => (options ? `--${c}` : c));
  if (named.length > 1) return `\n(Did you mean one of ${named.join(", ")}?)`;
  return named.length === 1 ? `\n(Did you mean ${named[0]}?)` : "";
}
