// `Blob` and `File` for functions, with the File API's `type` as Convex's runtime gives it
// (npm-packages/udf-runtime/src/09_file.ts, STUDY-133 §12 M14, DV-441): the type given, lower-cased, or ""
// when it holds a character outside U+0020–U+007E; `slice()` without a type is "". Bun's own `Blob` swaps a
// type it knows for its MIME table's (`text/plain` → `text/plain;charset=utf-8`, `application/javascript` →
// `text/javascript;charset=utf-8`), which a stored file's `contentType` would keep.

const PRINTABLE = /^[\x20-\x7e]*$/;
const HostBlob = globalThis.Blob;
const HostFile = globalThis.File;

/** The File API's type normalization (Convex's `_normalizeType`). */
export const blobType = (type: unknown): string => {
  const s = type === undefined ? "" : `${type}`;
  return s && PRINTABLE.test(s) ? s.toLowerCase() : "";
};

type BlobParts = ConstructorParameters<typeof Blob>[0];
type BlobOptions = ConstructorParameters<typeof Blob>[1];
type FileOptions = ConstructorParameters<typeof File>[2];
const hostSlice = (HostBlob.prototype as unknown as { slice: (this: Blob, start?: number, end?: number) => Blob })
  .slice;

const types = new WeakMap<Blob, string>();
const typeOf = (b: Blob) => types.get(b) ?? b.type;

function slice(this: Blob, start?: number, end?: number, contentType?: string): Blob {
  return new SpecBlob([hostSlice.call(this, start, end)], { type: contentType });
}

export class SpecBlob extends HostBlob {
  constructor(parts?: BlobParts, options?: BlobOptions) {
    super(parts, options);
    types.set(this, blobType((options as { type?: unknown } | undefined)?.type));
  }
  override get type(): string {
    return typeOf(this);
  }
  // Every Blob (Bun's own, a `File`, a `Response`'s) is one, as in a runtime with a single Blob class.
  static override [Symbol.hasInstance](x: unknown) {
    return x instanceof HostBlob;
  }
}
Object.defineProperty(SpecBlob.prototype, "slice", { value: slice, writable: true, configurable: true });

export class SpecFile extends HostFile {
  constructor(parts: ConstructorParameters<typeof File>[0], name: string, options?: FileOptions) {
    super(parts, name, options);
    types.set(this, blobType((options as { type?: unknown } | undefined)?.type));
  }
  override get type(): string {
    return typeOf(this);
  }
  static override [Symbol.hasInstance](x: unknown) {
    return x instanceof HostFile;
  }
}
Object.defineProperty(SpecFile.prototype, "slice", { value: slice, writable: true, configurable: true });
