// The custom test query's compiler options (STUDY-162), Convex's `FunctionEditor.tsx`'s: the newest target, Node's
// module resolution over the editor's `node_modules`, strict, isolated modules. Plain values (TypeScript's enum
// numbers) so the editor and the tests share them without loading Monaco: target ESNext (99), module ESNext (99),
// moduleResolution Node10 (2).
export const QUERY_COMPILER_OPTIONS = {
  target: 99,
  module: 99,
  moduleResolution: 2,
  allowNonTsExtensions: true,
  isolatedModules: true,
  strict: true,
  skipLibCheck: true,
  noEmitOnError: false,
} as const;
