// A command line parsed, and its misuse reported, as Rust's clap 4.5 does for Convex's `convex-local-backend`
// (STUDY-172): `bunvex-local-backend` gives the same messages for the same mistakes. clap's rules, as its
// `clap_builder` 4.5.31 (Convex's Cargo.lock at d8bdde0) applies them:
//
// - an argument is shown as `--long <VALUE_NAME>`, the value name its field's name uppercased (`--site-proxy-port
//   <SITE_PROXY_PORT>`); the positional as `[DB_SPEC]`, `<DB_SPEC>` once given;
// - an option's value is the next word unless that looks like a flag (`-x`, `--x`; `-` alone is a value), or
//   attached (`--port=1`, `-p1`, `-p=1`); `--` ends the options. A value given as the next word is checked when the
//   word after it is read, and that check's error is dropped when that word is an unknown argument;
// - each error is `error: <message>`, the possible values, a tip, a `Usage:` line for some, then "For more
//   information, try '--help'."; the usage line is the help's, or one built from the arguments given (clap's
//   "smart usage", which shows the derive's group of every argument as `<a|b|…>` once one of them is matched);
// - after the parse: conflicts (a group whose members exclude each other), then requirements (`requires`, and the
//   arguments a subcommand requires);
// - a similar argument, value or subcommand is suggested when its Jaro similarity is over 0.7, the most similar
//   (the later one on a tie).

/** An argument: `--<id>`, maybe `-<short>`; with a value of some possible values or a checked form, or a flag. */
export type ArgSpec = {
  id: string;
  short?: string;
  /** The value's possible values (clap's `value_enum`), or its check (an error's reason, or null). */
  value?: { possible: readonly string[] } | { check: (raw: string) => string | null };
  requires?: readonly string[];
  /** Required (a subcommand's arguments, as `keygen admin-key`'s). */
  required?: boolean;
  /** Members of one group exclude each other (Convex's `storage` group). */
  group?: string;
  /** clap's own `--help` / `--version`: outside the derive's group. */
  action?: "help" | "version";
};

export type CommandSpec = {
  /** The usage's program and subcommand path: `bunvex-local-backend keygen admin-key`. */
  name: string;
  args: readonly ArgSpec[];
  /** The one positional (its value name). */
  positional?: string;
  subcommands?: readonly string[];
  subcommandRequired?: boolean;
};

export type ParsedCommand =
  | { kind: "ok"; values: Map<string, string | true>; positional?: string }
  | { kind: "subcommand"; name: string; rest: string[] }
  | { kind: "help" | "version" }
  /** A subcommand that needs one, without it: its help, as an error (exit 2). */
  | { kind: "missing-subcommand" }
  | { kind: "error"; text: string };

const ALL = "#all";
const POSITIONAL = "#positional";

export const valueName = (id: string) => id.replaceAll("-", "_").toUpperCase();
export const argText = (a: ArgSpec) => (a.value ? `--${a.id} <${valueName(a.id)}>` : `--${a.id}`);

/** strsim's `jaro`, which clap's suggestions use. */
export function jaro(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(x.length, y.length) / 2) - 1);
  const taken: boolean[] = new Array(y.length).fill(false);
  let matches = 0;
  let transpositions = 0;
  let lastJ = 0;
  for (let i = 0; i < x.length; i++) {
    const lo = i > range ? i - range : 0;
    const hi = Math.min(y.length, i + range + 1);
    for (let j = lo; j < hi; j++) {
      if (!taken[j] && x[i] === y[j]) {
        taken[j] = true;
        matches++;
        if (j < lastJ) transpositions++;
        lastJ = j;
        break;
      }
    }
  }
  if (!matches) return 0;
  return (matches / x.length + matches / y.length + (matches - transpositions) / matches) / 3;
}

/** clap's `did_you_mean`: the most similar candidate over 0.7, the later one on a tie. */
export function didYouMean(v: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let score = 0.7;
  for (const c of candidates) {
    const s = jaro(v, c);
    if (s > 0.7 && s >= score) {
      best = c;
      score = s;
    }
  }
  return best;
}

/** An error as clap's rich formatter writes it, without colours. */
export function errorText(message: string, more: { possible?: readonly string[]; tip?: string; usage?: string } = {}) {
  const lines = [`error: ${message}`];
  if (more.possible) lines.push(`  [possible values: ${more.possible.join(", ")}]`);
  if (more.tip) lines.push("", `  tip: ${more.tip}`);
  if (more.usage) lines.push("", more.usage);
  lines.push("", "For more information, try '--help'.");
  return lines.join("\n");
}

/** Parse `argv` for `cmd`. `present` names the arguments an environment variable gives (clap's `env =`). */
export function parseCommand(
  cmd: CommandSpec,
  argv: readonly string[],
  present: readonly string[] = [],
): ParsedCommand {
  const byId = new Map(cmd.args.map((a) => [a.id, a]));
  const own = cmd.args.filter((a) => !a.action);
  const groupOf = (id: string) =>
    id === POSITIONAL ? [ALL] : byId.get(id)?.action ? [] : [ALL, byId.get(id)?.group].filter((g) => g !== undefined);
  const membersOf = (g: string) =>
    g === ALL
      ? [...(cmd.positional ? [POSITIONAL] : []), ...own.map((a) => a.id)]
      : own.filter((a) => a.group === g).map((a) => a.id);
  const isGroup = (id: string) => id === ALL || own.some((a) => a.group === id);
  const requiresOf = (id: string) => byId.get(id)?.requires ?? [];
  const staticRequired = cmd.args.filter((a) => a.required).map((a) => a.id);

  // clap's matcher: the ids matched, each argument followed by its groups, in order.
  const matched: string[] = [];
  const values = new Map<string, string | true>();
  let positional: string | undefined;
  const start = (id: string) => {
    for (const x of [id, ...groupOf(id)]) if (!matched.includes(x)) matched.push(x);
  };

  /** clap's `unroll_arg_requires`. */
  const unroll = (id: string) => {
    const processed: string[] = [];
    const stack = [id];
    const out: string[] = [];
    while (stack.length) {
      const a = stack.pop()!;
      if (processed.includes(a)) continue;
      processed.push(a);
      for (const r of requiresOf(a)) {
        if (requiresOf(r).length) stack.push(r);
        out.push(r);
      }
    }
    return out;
  };

  /** clap's `write_args`: the required arguments and `incls`, groups unrolled, then the positional. */
  const writeArgs = (incls: readonly string[], graph: readonly string[]) => {
    const all = [...graph.flatMap((a) => [...unroll(a), a]), ...incls];
    const groups: string[] = [];
    const members = new Set<string>();
    for (const r of all)
      if (isGroup(r)) {
        const text = `<${membersOf(r)
          .map((m) => (m === POSITIONAL ? cmd.positional! : argText(byId.get(m)!)))
          .join("|")}>`;
        if (!groups.includes(text)) groups.push(text);
        for (const m of membersOf(r)) members.add(m);
      }
    const opts: string[] = [];
    let pos: string | undefined;
    for (const r of all) {
      if (isGroup(r) || members.has(r)) continue;
      if (r === POSITIONAL) pos = `<${cmd.positional}>`;
      else {
        const text = argText(byId.get(r)!);
        if (!opts.includes(text)) opts.push(text);
      }
    }
    if (cmd.positional && !members.has(POSITIONAL)) pos ??= `[${cmd.positional}]`;
    return [...opts, ...groups, ...(pos ? [pos] : [])];
  };

  /** clap's usage line: the help's when nothing is given, else the one built from `used`. */
  const usage = (used: readonly string[], graph: readonly string[] = staticRequired) => {
    const parts = [cmd.name];
    if (!used.length) {
      if (own.some((a) => !a.required)) parts.push("[OPTIONS]");
      parts.push(...writeArgs([], graph));
      if (cmd.subcommands?.length) parts.push(cmd.subcommandRequired ? "<COMMAND>" : "[COMMAND]");
    } else {
      parts.push(...writeArgs(used, graph));
      if (cmd.subcommandRequired) parts.push("<COMMAND>");
    }
    return `Usage: ${parts.join(" ")}`;
  };
  const usedSoFar = () => [...matched];
  const usedArgs = () => matched.filter((id) => !isGroup(id));

  const emptyValue = (a: ArgSpec) =>
    errorText(`a value is required for '${argText(a)}' but none was supplied`, {
      ...(a.value && "possible" in a.value ? { possible: a.value.possible } : {}),
    });
  const multiple = (a: ArgSpec) =>
    errorText(`the argument '${argText(a)}' cannot be used multiple times`, { usage: usage([]) });

  /** clap's `react` for an option's value: present once, then the value checked. */
  const take = (a: ArgSpec, raw: string | undefined): string | null => {
    if (raw === undefined) return emptyValue(a);
    if (values.has(a.id)) return multiple(a);
    start(a.id);
    const v = a.value!;
    if ("possible" in v) {
      if (raw === "") return emptyValue(a);
      if (!v.possible.includes(raw)) {
        const like = didYouMean(raw, v.possible);
        return errorText(`invalid value '${raw}' for '${argText(a)}'`, {
          possible: v.possible,
          ...(like ? { tip: `a similar value exists: '${like}'` } : {}),
        });
      }
    } else {
      const reason = v.check(raw);
      if (reason !== null) return errorText(`invalid value '${raw}' for '${argText(a)}': ${reason}`);
    }
    values.set(a.id, raw);
    return null;
  };

  // An option whose value is the next word, waiting for it (`raw` undefined) or for the word after it.
  let pending: { arg: ArgSpec; raw?: string } | null = null;
  const resolve = () => {
    const p = pending;
    pending = null;
    return p ? take(p.arg, p.raw) : null;
  };
  const longs = () => cmd.args.map((a) => a.id);
  const tipDash = (word: string, trailing: boolean) =>
    cmd.positional && !trailing ? `to pass '${word}' as a value, use '-- ${word}'` : undefined;

  const unknownLong = (name: string, trailing: boolean) => {
    resolve(); // its error is dropped, as clap's
    const like = didYouMean(name, longs());
    if (like) start(like);
    const tip = like ? `a similar argument exists: '--${like}'` : tipDash(`--${name}`, trailing);
    return errorText(`unexpected argument '--${name}' found`, {
      ...(tip ? { tip } : {}),
      usage: usage(usedSoFar()),
    });
  };
  const unknownShort = (word: string, trailing: boolean) => {
    resolve();
    const tip = tipDash(word, trailing);
    return errorText(`unexpected argument '${word}' found`, { ...(tip ? { tip } : {}), usage: usage([]) });
  };
  // A word with no positional left: a subcommand's misspelling when one is similar, or always when the command
  // takes no positional (clap's `match_arg_error`).
  const extraPositional = (word: string) => {
    const like = cmd.subcommands?.length ? didYouMean(word, cmd.subcommands) : undefined;
    if (!like && !(cmd.subcommands?.length && !cmd.positional))
      return errorText(`unexpected argument '${word}' found`, { usage: usage([]) });
    return errorText(`unrecognized subcommand '${word}'`, {
      ...(like ? { tip: `a similar subcommand exists: '${like}'` } : {}),
      usage: usage([]),
    });
  };

  let trailing = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    const looksLikeFlag = word.startsWith("-") && word !== "-";
    if (!trailing) {
      if (pending && pending.raw === undefined && !looksLikeFlag) {
        pending.raw = word;
        continue;
      }
      if (cmd.subcommands?.includes(word)) {
        const err = resolve();
        if (err) return { kind: "error", text: err };
        return { kind: "subcommand", name: word, rest: argv.slice(i + 1) };
      }
      if (word === "--") {
        trailing = true;
        continue;
      }
      if (word.startsWith("--")) {
        const eq = word.indexOf("=");
        const name = eq < 0 ? word.slice(2) : word.slice(2, eq);
        const inline = eq < 0 ? undefined : word.slice(eq + 1);
        const a = byId.get(name);
        if (!a) return { kind: "error", text: unknownLong(name, trailing) };
        if (!a.value && inline !== undefined) {
          // Computed before the waiting option is taken, as clap's.
          const used = [...usedSoFar().filter((id) => !staticRequired.includes(id)), a.id];
          return {
            kind: "error",
            text: errorText(`unexpected value '${inline}' for '--${a.id}' found; no more were expected`, {
              usage: usage(used),
            }),
          };
        }
        const err = resolve();
        if (err) return { kind: "error", text: err };
        if (a.action) return { kind: a.action };
        if (!a.value) {
          if (values.has(a.id)) return { kind: "error", text: multiple(a) };
          start(a.id);
          values.set(a.id, true);
        } else if (inline !== undefined) {
          const bad = take(a, inline);
          if (bad) return { kind: "error", text: bad };
        } else pending = { arg: a };
        continue;
      }
      if (looksLikeFlag) {
        const c = word[1]!;
        const a = cmd.args.find((x) => x.short === c);
        if (!a) return { kind: "error", text: unknownShort(`-${c}`, trailing) };
        const err = resolve();
        if (err) return { kind: "error", text: err };
        if (a.action) return { kind: a.action };
        const rest = word.slice(2);
        if (rest === "") pending = { arg: a };
        else {
          const bad = take(a, rest.startsWith("=") ? rest.slice(1) : rest);
          if (bad) return { kind: "error", text: bad };
        }
        continue;
      }
    }
    const err = resolve();
    if (err) return { kind: "error", text: err };
    if (!cmd.positional || positional !== undefined) return { kind: "error", text: extraPositional(word) };
    positional = word;
    start(POSITIONAL);
  }
  const err = resolve();
  if (err) return { kind: "error", text: err };
  if (cmd.subcommandRequired) return { kind: "missing-subcommand" };

  // What an environment variable gives counts as given, after the command line.
  for (const id of present) if (!values.has(id)) start(id);
  const isPresent = (id: string) => matched.includes(id);

  // Conflicts: two members of one group.
  for (const id of usedArgs()) {
    const g = byId.get(id)?.group;
    const other = g && usedArgs().find((o) => o !== id && byId.get(o)?.group === g);
    if (!other) continue;
    const kept = usedArgs().filter((o) => o !== other);
    const reqs = kept.flatMap((k) => requiresOf(k)).filter((r) => !kept.includes(r) && r !== other);
    return {
      kind: "error",
      text: errorText(`the argument '${argText(byId.get(id)!)}' cannot be used with '${argText(byId.get(other)!)}'`, {
        usage: usage([...reqs, ...kept]),
      }),
    };
  }

  // Requirements: the required arguments, and what each given one requires.
  const graph = [...staticRequired];
  for (const id of usedArgs()) for (const r of unroll(id)) if (!graph.includes(r)) graph.push(r);
  const missing = graph.filter((id) => !isPresent(id));
  if (missing.length) {
    const listed: string[] = [];
    for (const r of [...graph.flatMap((a) => [...unroll(a), a]), ...missing])
      if (!isPresent(r) && !listed.includes(r)) listed.push(r);
    return {
      kind: "error",
      text: errorText(
        `the following required arguments were not provided:\n${listed.map((r) => `  ${argText(byId.get(r)!)}`).join("\n")}`,
        { usage: usage([...usedArgs(), ...missing], graph) },
      ),
    };
  }
  return { kind: "ok", values, ...(positional === undefined ? {} : { positional }) };
}

/** clap's `u16`: Rust's `i64` parse, then the range. */
export function portError(raw: string): string | null {
  if (raw === "") return "cannot parse integer from empty string";
  if (!/^[+-]?[0-9]+$/.test(raw)) return "invalid digit found in string";
  const n = BigInt(raw);
  if (n > 2n ** 63n - 1n) return "number too large to fit in target type";
  if (n < -(2n ** 63n)) return "number too small to fit in target type";
  return n < 0n || n > 65535n ? `${n} is not in 0..=65535` : null;
}

/** Rust's `Ipv4Addr` parse: four decimal octets, no leading zeros. */
export function ipv4Error(raw: string): string | null {
  const parts = raw.split(".");
  const ok = parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
  return ok ? null : "invalid IPv4 address syntax";
}
