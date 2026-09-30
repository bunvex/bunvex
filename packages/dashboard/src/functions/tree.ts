// The deployment's functions as a file tree (STUDY-12 §7): a module path `a/b/file` gives folders `a` and
// `a/b` and the file `file`; its functions (`a/b/file:name`) are the file's leaves. Folders come before
// files, each alphabetical; functions alphabetical (Convex orders them by source line, which the contract
// does not carry).
import type { FunctionInfo } from "../data-source.ts";

export type FunctionFile = { kind: "file"; name: string; module: string; functions: FunctionInfo[] };
export type FunctionFolder = { kind: "folder"; name: string; path: string; children: FunctionNode[] };
export type FunctionNode = FunctionFolder | FunctionFile;

/** "a/b/file:name" → { module: "a/b/file", name: "name" }. */
export function splitPath(path: string): { module: string; name: string } {
  const i = path.lastIndexOf(":");
  return i < 0 ? { module: path, name: "default" } : { module: path.slice(0, i), name: path.slice(i + 1) };
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function sortNodes(nodes: FunctionNode[]): FunctionNode[] {
  const folders = nodes.filter((n): n is FunctionFolder => n.kind === "folder").sort(byName);
  const files = nodes.filter((n): n is FunctionFile => n.kind === "file").sort(byName);
  for (const f of folders) f.children = sortNodes(f.children);
  for (const f of files) f.functions.sort((a, b) => byName(splitPath(a.path), splitPath(b.path)));
  return [...folders, ...files];
}

export function buildFunctionTree(functions: FunctionInfo[]): FunctionNode[] {
  const root: FunctionNode[] = [];
  const folders = new Map<string, FunctionFolder>();
  const files = new Map<string, FunctionFile>();
  const folder = (path: string): FunctionNode[] => {
    if (path === "") return root;
    let f = folders.get(path);
    if (!f) {
      const slash = path.lastIndexOf("/");
      f = { kind: "folder", name: path.slice(slash + 1), path, children: [] };
      folders.set(path, f);
      folder(slash < 0 ? "" : path.slice(0, slash)).push(f);
    }
    return f.children;
  };
  for (const fn of functions) {
    const { module } = splitPath(fn.path);
    let file = files.get(module);
    if (!file) {
      const slash = module.lastIndexOf("/");
      file = { kind: "file", name: module.slice(slash + 1), module, functions: [] };
      files.set(module, file);
      folder(slash < 0 ? "" : module.slice(0, slash)).push(file);
    }
    file.functions.push(fn);
  }
  return sortNodes(root);
}

/** The functions whose path contains `text`, ignoring case. */
export const matchFunctions = (functions: FunctionInfo[], text: string) => {
  const t = text.trim().toLowerCase();
  return t === "" ? functions : functions.filter((f) => f.path.toLowerCase().includes(t));
};

/** "Internal query", "Action". */
export const describeFunction = (f: FunctionInfo) =>
  f.visibility === "internal" ? `Internal ${f.kind}` : f.kind[0]!.toUpperCase() + f.kind.slice(1);
