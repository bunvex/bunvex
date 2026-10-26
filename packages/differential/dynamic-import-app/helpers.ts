// A sibling module the functions of `dynamic.ts` import at run time.
export function fibonacci(n: number): number {
  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}
