// What an extension's contract-suite part receives (UI-01 §26).
import type { DashboardDataSource } from "../data-source.ts";

export type ContractContext = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
  watchTimeoutMs: number;
  /** Writes are opt-in (`ContractOptions.writes`): a part tests its writes only when this is true. */
  writes: boolean;
};

export type ContractExtensionPart = {
  id: string;
  /** The methods that must exist for the part to run (the extension's `requires`). */
  requires: readonly (keyof DashboardDataSource)[];
  describe: (ctx: ContractContext) => void;
};
