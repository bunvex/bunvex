// The size (Convex's `size()`, for the limits and the usage meter) of a version a transaction wrote, measured
// once when it was staged and shared by every later reader: the write limits, the I/O meter and the table
// summaries each needed it. Only versions the transaction built itself are kept (a function never gets one
// of them: reading its own write hands out a copy), so they never change after being measured.
import { rawValueSize, type Value } from "@bunvex/values";

const sizes = new WeakMap<object, number>();

/** Remember `size` as the size of a version `stage` built. */
export function rememberStagedSize(doc: object, size: number): void {
  sizes.set(doc, size);
}

/** A staged version's size as measured, else measured now. */
export function sizeOfVersion(doc: object): number {
  return sizes.get(doc) ?? rawValueSize(doc as Value);
}
