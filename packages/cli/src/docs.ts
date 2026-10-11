// `bunvex docs` and `bunvex update` (STUDY-146): Convex's `npx convex docs` and `update`
// (npm-packages/convex/src/cli/docs.ts, update.ts), with bunvex's URLs and package (rule 5, DV-461). Their lines go
// to stderr, as Convex's `logMessage`.
import { argumentError, optionsIn, tooManyArguments, unknownOption } from "./args.ts";
import { openInBrowser } from "./browser.ts";
import type { Io } from "./io.ts";

/** Convex's `https://docs.convex.dev/?utm_source=convex-cli`: bunvex's site, which is to hold its docs. */
export const DOCS_URL = "https://bunvex.dev/?utm_source=bunvex-cli";
/** Convex's `https://news.convex.dev/tag/releases/`: the changelog of the package an app installs. */
export const CHANGELOG_URL = "https://github.com/bunvex/bunvex/blob/main/packages/bunvex/CHANGELOG.md";

export const DOCS_USAGE = `Usage: bunvex docs [options]

Open the docs in the browser

Options:
  --no-open            Print docs URL instead of opening it in your browser`;

export const UPDATE_USAGE = `Usage: bunvex update [options]

Print instructions for updating the bunvex package`;

/**
 * A command with no arguments, and `--no-open` when it has the option: whether to open, or the exit code of an
 * argument error (commander's messages; the help after them for a command Convex builds with `showHelpAfterError`).
 */
export function parseNoArguments(
  args: string[],
  io: Io,
  o: { command: string; usage: string; noOpen: boolean; helpAfterError: boolean },
): { open: boolean } | number {
  let open = true;
  let positional = 0;
  const help = o.helpAfterError ? o.usage : undefined;
  for (const a of args) {
    if (o.noOpen && a === "--no-open") open = false;
    else if (a.startsWith("-")) return argumentError(io, unknownOption(a, optionsIn(o.usage)), help);
    else positional++;
  }
  if (positional) return argumentError(io, tooManyArguments(o.command, 0, positional), help);
  return { open };
}

export async function docsCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(DOCS_USAGE);
    return 0;
  }
  const flags = parseNoArguments(args, io, { command: "docs", usage: DOCS_USAGE, noOpen: true, helpAfterError: false });
  if (typeof flags === "number") return flags;
  if (!flags.open) {
    io.err(`Find bunvex docs here: ${DOCS_URL}`);
    return 0;
  }
  try {
    await (io.open ?? openInBrowser)(DOCS_URL);
  } catch (e) {
    // Convex's command does not catch it: the CLI fails with the error.
    io.err(`bunvex docs: ${(e as Error).message}`);
    return 1;
  }
  io.err("Docs have launched! Check your browser.");
  return 0;
}

export async function updateCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(UPDATE_USAGE);
    return 0;
  }
  const flags = parseNoArguments(args, io, {
    command: "update",
    usage: UPDATE_USAGE,
    noOpen: false,
    helpAfterError: false,
  });
  if (typeof flags === "number") return flags;
  // Convex's three lines and an empty one. Like Convex's, it asks no registry which version is the latest.
  io.err(
    `To view the bunvex changelog, go to ${CHANGELOG_URL}\nWhen you are ready to upgrade, run the following command:\nnpm install bunvex@latest\n`,
  );
  return 0;
}
