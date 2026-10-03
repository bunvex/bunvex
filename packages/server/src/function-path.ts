// A function path as Convex parses it before a call (`parse_export_path` / `parse_udf_path`,
// crates/local_backend/src/parse.rs; `UdfPath`, `ModulePath`, `check_valid_path_component` and
// `check_valid_identifier` in crates/convex/sync_types/src). A path that does not parse is the request's
// error: 400, with the reason (STUDY-67 H7).

/** Convex's `MAX_IDENTIFIER_LEN`. */
const MAX_IDENTIFIER_LEN = 64;

/** A character as Rust's `{:?}` shows a `char`: `'-'`, `'\n'`. */
const rustChar = (c: string) => {
  const esc: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\\": "\\\\", "'": "\\'", "\0": "\\0" };
  return `'${esc[c] ?? c}'`;
};

const isAsciiAlnum = (c: string) => /^[A-Za-z0-9]$/.test(c);

function checkPathComponent(s: string): string | null {
  const len = Buffer.byteLength(s);
  if (len > MAX_IDENTIFIER_LEN)
    return `Path component is too long (${len} > maximum ${MAX_IDENTIFIER_LEN}): ${s.slice(0, MAX_IDENTIFIER_LEN)}...`;
  if (![...s].every((c) => isAsciiAlnum(c) || c === "_" || c === "."))
    return `Path component ${s} can only contain alphanumeric characters, underscores, or periods.`;
  if (![...s].some(isAsciiAlnum)) return `Path component ${s} must have at least one alphanumeric character.`;
  return null;
}

function checkIdentifier(s: string): string | null {
  const chars = [...s];
  const first = chars[0];
  if (first === undefined) return "Identifier cannot be empty";
  if (!/^[A-Za-z_]$/.test(first))
    return `Invalid first character ${rustChar(first)} in ${s}: Identifiers must start with an alphabetic character or underscore`;
  for (const c of chars.slice(1))
    if (!isAsciiAlnum(c) && c !== "_")
      return `Identifier ${s} has invalid character ${rustChar(c)}: Identifiers can only contain alphanumeric characters or underscores`;
  const len = Buffer.byteLength(s);
  if (len > MAX_IDENTIFIER_LEN) return `Identifier is too long (${len} > maximum ${MAX_IDENTIFIER_LEN})`;
  if (chars.every((c) => c === "_")) return `Identifier ${s} cannot have exclusively underscores`;
  return null;
}

/**
 * Rust's `Path::components` on a Unix path: `/` a root, `.` only as the first component, `..` anywhere,
 * empty segments and inner `.` dropped.
 */
function components(p: string): string[] {
  const out: string[] = [];
  const segs = p.split("/");
  if (p.startsWith("/")) out.push("/");
  segs.forEach((seg, k) => {
    if (seg === "") return;
    if (seg === "." && !(k === 0 && !p.startsWith("/"))) return;
    out.push(seg);
  });
  return out;
}

/** Rust's `Path::file_name` and `extension`. */
function fileName(p: string): string | null {
  const last = components(p).at(-1);
  return last === undefined || last === "/" || last === "." || last === ".." ? null : last;
}
function extension(name: string): string | null {
  const i = name.lastIndexOf(".");
  return i <= 0 ? null : name.slice(i + 1);
}

function checkModulePath(p: string): string | null {
  const name = fileName(p);
  if (name === null) return `Module path ${p} doesn't have a filename.`;
  const ext = extension(name);
  if (ext !== null && ext !== "js") return `Module path (${p}) has an extension that isn't 'js'.`;
  const comps = components(p);
  for (const c of comps) {
    if (c === "/") return `Module paths must be relative (${p} is absolute).`;
    if (c === ".") return `Invalid path component CurDir in ${p}.`;
    if (c === "..") return `Invalid path component ParentDir in ${p}.`;
  }
  // Canonicalized: `.js` added to a file name without an extension; every component checked.
  const canonical = ext === null ? [...comps.slice(0, -1), `${name}.js`] : comps;
  for (const c of canonical) {
    const e = checkPathComponent(c);
    if (e !== null) return e;
  }
  return null;
}

/** Why a function path does not parse (`module[:function]`), or null when it does. */
export function functionPathError(path: string): string | null {
  const i = path.lastIndexOf(":");
  const [module, fn] = i < 0 ? [path, null] : [path.slice(0, i), path.slice(i + 1)];
  return checkModulePath(module) ?? (fn === null ? null : checkIdentifier(fn));
}

/** Convex's 400 for a path that does not parse (`BadConvexFunctionIdentifier`), with bunvex's code (DV-312) and words. */
export function badFunctionPath(path: string): { status: 400; code: string; message: string } | null {
  const why = functionPathError(path);
  return why === null
    ? null
    : {
        status: 400,
        code: "BadBunvexFunctionIdentifier",
        message: `${path} is not a valid path to a bunvex function. ${why}`,
      };
}
