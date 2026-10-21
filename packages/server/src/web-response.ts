// `Response` for functions, with the headers Convex's runtime gives it (npm-packages/udf-runtime/src/23_response.ts
// and 22_body.ts `extractBody` at d8bdde0, STUDY-31 §8). Unless the init names a Content-Type, the body's own goes
// in the headers when the response is built: a string (or any value that is not a body type, made one)
// `text/plain;charset=UTF-8`, a URLSearchParams `application/x-www-form-urlencoded;charset=UTF-8`, a FormData its
// multipart type, a Blob its File API type (DV-441), nothing for bytes, a stream or no body. `Response.json` always
// sets `application/json`, an explicit one too. Bun puts a string's type on the wire only when it writes the body
// itself, its Blob's in its MIME table's form and its JSON's with `;charset=utf-8`.
//
// A body that is not a stream has a known length, which Convex sends as `content-length`; `bodyLength` tells the
// HTTP action server so (STUDY-31 §8).
import { isAnyArrayBuffer } from "node:util/types";
import { blobType } from "./web-blob.ts";

const HostResponse = globalThis.Response;
type Body = NonNullable<ConstructorParameters<typeof Response>[0]>;
type Init = ConstructorParameters<typeof Response>[1];

/** The responses built with a body that is not a stream: its size in bytes, or null when it takes encoding. */
const lengths = new WeakMap<Response, number | null>();

/**
 * The length of a response's body if it is known up front, as Convex's `[[contentLength]]`: a number for bytes or a
 * Blob, null for a body still to encode (a string, a URLSearchParams, a FormData), undefined for a stream, no body,
 * or a Response not built by a function (`fetch`'s).
 */
export const bodyLength = (r: Response): number | null | undefined => lengths.get(r);

/**
 * `r`, read by the HTTP action server as a function's response whose body had `length` (`bodyLength`): the function
 * sandbox's host rebuilds a response its child made (STUDY-168 PR 6).
 */
export function withBodyLength(r: Response, length: number | null): Response {
  lengths.set(r, length);
  return r;
}

/** WebIDL's conversion of a body (Convex's `convertBodyInit`): a value that is no body type becomes a string. */
function convertBody(body: unknown): Body {
  if (
    typeof body === "string" ||
    body instanceof ReadableStream ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    // The function's realm has its own ArrayBuffer.
    isAnyArrayBuffer(body) ||
    ArrayBuffer.isView(body)
  )
    return body as Body;
  // A template literal throws for a symbol, as WebIDL's ToString.
  return `${body as string}`;
}

/** The Content-Type a body brings (Convex's `extractBody`); undefined for FormData, whose boundary Bun picks. */
function bodyType(body: Body): string | null | undefined {
  if (typeof body === "string") return "text/plain;charset=UTF-8";
  if (body instanceof URLSearchParams) return "application/x-www-form-urlencoded;charset=UTF-8";
  if (body instanceof FormData) return undefined;
  if (body instanceof Blob) return blobType(body.type) || null;
  return null;
}

export class SpecResponse extends HostResponse {
  constructor(body?: unknown, init?: Init) {
    const converted = body === undefined || body === null ? null : convertBody(body);
    const explicit =
      init?.headers !== undefined &&
      new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).has("content-type");
    super(converted, init);
    if (converted === null) return;
    if (!(converted instanceof ReadableStream))
      lengths.set(
        this,
        converted instanceof Blob
          ? converted.size
          : isAnyArrayBuffer(converted) || ArrayBuffer.isView(converted)
            ? converted.byteLength
            : null,
      );
    if (explicit) return;
    const type = bodyType(converted);
    if (type) this.headers.set("content-type", type);
    // Read now, so Bun's own type (a FormData's boundary) is in the headers whatever is read first.
    else if (type === undefined) void this.headers;
    // A Blob with no File API type that Bun's MIME table would still type.
    else if (converted instanceof Blob) this.headers.delete("content-type");
  }

  /** Convex's `Response.json`: `application/json`, over an explicit Content-Type too. */
  static override json(data: unknown, init?: Init): Response {
    let body: string | undefined;
    try {
      body = JSON.stringify(data);
    } catch {
      body = undefined;
    }
    if (body === undefined)
      throw new TypeError("Failed to execute 'json' on 'Response': The data is not JSON serializable");
    const r = new SpecResponse(body, init);
    r.headers.set("content-type", "application/json");
    return r;
  }

  // Every Response (`fetch`'s, `Response.redirect`'s) is one, as in a runtime with a single Response class.
  static override [Symbol.hasInstance](x: unknown) {
    return x instanceof HostResponse;
  }
}
