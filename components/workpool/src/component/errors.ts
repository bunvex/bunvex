// The non-retryable error (STUDY-199 §1.15), as Convex's workpool 0.4.14 has it, on `BunvexError` (DV-538): its data
// carries the marker `__bunvexWorkpoolNonRetryable: true` and the message. Across a call the class is lost and the
// caller gets a `BunvexError` with the same data, so the data is what is checked.
import { BunvexError, isBunvexError } from "@bunvex/values";

const MARKER = "__bunvexWorkpoolNonRetryable";

type Marker = { readonly [MARKER]: true };
type NonRetryableData = Marker & { message: string };

/** Throw it from a job to end it at once as failed, whatever its retry behavior. */
export class NonRetryableError extends BunvexError<NonRetryableData> {
  constructor(message: string, options?: ErrorOptions) {
    super({ [MARKER]: true, message });
    this.name = new.target.name;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const isData = (data: unknown): data is NonRetryableData =>
  typeof data === "object" &&
  data !== null &&
  (data as Partial<Marker>)[MARKER] === true &&
  typeof (data as Partial<NonRetryableData>).message === "string";

const hasMarker = (e: unknown): e is Partial<NonRetryableData> =>
  typeof e === "object" && e !== null && (e as Partial<Marker>)[MARKER] === true;

/**
 * Whether `error` asks not to be retried: a {@link NonRetryableError}, or an error whose data (or the object itself)
 * carries its marker, as one thrown by a function another one called.
 */
export function isNonRetryableError(error: unknown): boolean {
  if (error instanceof NonRetryableError) return true;
  if (isBunvexError(error)) return isData(error.data);
  return hasMarker(error);
}

/** The message a non-retryable error carries, or undefined for any other error. */
export function getNonRetryableErrorMessage(error: unknown): string | undefined {
  if (isBunvexError(error)) return isData(error.data) ? error.data.message : undefined;
  if (hasMarker(error)) return typeof error.message === "string" ? error.message : undefined;
  return undefined;
}
