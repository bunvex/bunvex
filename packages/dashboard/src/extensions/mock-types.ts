// What an extension's mock part receives from `MockDataSource` (UI-01 §26), so it shares the mock's clock,
// randomness, latency/failure knobs, credentials and audit log instead of keeping its own.
import type { CallOptions, Operation } from "../data-source.ts";
import type { Random } from "../mock/random.ts";

export type MockContext = {
  rnd: Random;
  /** The mock's clock (ms). */
  now: () => number;
  /** Runs `fn` like every mock call: latency, injected failures, abort. */
  call: <T>(signal: AbortSignal | undefined, fn: () => T) => Promise<T>;
  /** Whether the credential has this operation (and, for writes, is not read-only). */
  can: (op: Operation | "write") => boolean;
  /** Writes an audit event (the History screen's), as the mock's own writes do. */
  record: (action: string, metadata: Record<string, unknown>) => void;
  /** Mock options the part may read (its own knobs), as passed to `new MockDataSource(opts)`. */
  options: Record<string, unknown>;
};

export type MockExtensionPart = {
  id: string;
  /** The methods this extension adds to the mock (its contract's optional methods). */
  create: (ctx: MockContext) => Record<string, (...args: never[]) => unknown>;
};

export type { CallOptions };
