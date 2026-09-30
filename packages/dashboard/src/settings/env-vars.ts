// Environment variables' rules (STUDY-12 §9, as Convex's): what a name may be, how large a value and the
// whole set may be, and reading a pasted `.env` file. The Settings screen validates with them; the mock
// enforces them.

/** Starts with a letter or `_`; letters, digits and `_`. */
export const ENV_NAME = /^[a-zA-Z_]+[a-zA-Z0-9_]*$/;
export const MAX_NAME_LENGTH = 256;
export const MAX_VALUE_BYTES = 8 * 1024;
export const MAX_VARIABLES = 512;
export const MAX_TOTAL_BYTES = 512 * 1024;

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Why a name is not valid, or undefined. */
export function nameProblem(name: string): string | undefined {
  if (name === "") return "A name is required.";
  if (name.length > MAX_NAME_LENGTH) return `A name has at most ${MAX_NAME_LENGTH} characters.`;
  if (!ENV_NAME.test(name)) return "Start with a letter; use only letters, digits and underscores.";
  return undefined;
}

/** Why a value is not valid, or undefined. */
export function valueProblem(value: string): string | undefined {
  if (bytes(value) > MAX_VALUE_BYTES) return "A value is at most 8 KiB.";
  return undefined;
}

/** Not an error, but likely a mistake: quotes around the value, or spaces at its ends. */
export function valueWarning(value: string): string | undefined {
  if (value.length > 1 && /^(["'`]).*\1$/s.test(value))
    return "The quotes are part of the value. They belong in a shell or a .env file, not here.";
  if (value !== value.trim()) return "The value starts or ends with spaces.";
  return undefined;
}

/** Why the whole set is too large, or undefined. */
export function setProblem(vars: { name: string; value: string }[]): string | undefined {
  if (vars.length > MAX_VARIABLES) return `A deployment has at most ${MAX_VARIABLES} environment variables.`;
  const total = vars.reduce((n, v) => n + bytes(v.name) + bytes(v.value), 0);
  if (total > MAX_TOTAL_BYTES) return "Environment variables are at most 512 KiB in all.";
  return undefined;
}

/**
 * The variables of a pasted `.env` file: `NAME=value` lines, optionally `export`ed; `#` comments and blank
 * lines skipped; quotes around a value removed (`\n` expanded inside double quotes). Null when the text has
 * no such line — then it is not a `.env` file but a plain name.
 */
export function parseDotenv(text: string): { name: string; value: string }[] | null {
  const out: { name: string; value: string }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    const quote = value[0];
    if (value.length > 1 && (quote === '"' || quote === "'" || quote === "`") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else value = value.replace(/\s+#.*$/, "");
    out.push({ name: m[1]!, value });
  }
  return out.length > 0 ? out : null;
}

/** The variables as `.env` lines, quoting values that need it. */
export function formatDotenv(vars: { name: string; value: string }[]): string {
  const quote = (v: string) => (/^[\w./:@-]*$/.test(v) ? v : JSON.stringify(v));
  return vars.map((v) => `${v.name}=${quote(v.value)}`).join("\n");
}
