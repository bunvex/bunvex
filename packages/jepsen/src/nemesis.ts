// Faults to inject during a run (STUDY-57 §4). "none" is a run without faults.
import type { Nemesis } from "./runner.ts";

export const NEMESES: Record<string, () => Nemesis | undefined> = {
  none: () => undefined,
};

export function nemesisByName(name: string): Nemesis | undefined {
  const make = NEMESES[name];
  if (!make) throw new Error(`unknown nemesis "${name}" (known: ${Object.keys(NEMESES).join(", ")})`);
  return make();
}
