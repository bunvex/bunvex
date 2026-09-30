// What makes a table name (STUDY-12 D11), as Convex's dashboard checks it before creating a table: an
// identifier of letters, digits and `_`, not starting with a digit or `_`, at most 64 characters.

/** Why a name cannot be a table's, or undefined when it can. */
export function tableNameProblem(name: string): string | undefined {
  if (name === "") return "Table name cannot be empty.";
  if (name.startsWith("_")) return "Table name cannot start with an underscore.";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    return "Table name must only contain letters, digits or underscores, and cannot start with a digit.";
  if (name.length > 64) return "Table name must be 64 characters or less.";
  return undefined;
}
