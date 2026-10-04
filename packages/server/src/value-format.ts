// The `format` of a function result over HTTP (STUDY-67 H3): Convex's `ValueFormat` (`crates/value/src/
// export.rs`) and, when a request names none, its client's default (`ClientVersion::default_format`,
// `crates/common/src/version.rs`).
import { fromJsonValue, type JSONValue } from "@bunvex/values";
import { type Format, parseFormat, writeValue } from "./streaming-export.ts";

export type { Format };
export { parseFormat };

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The format a client gets when it names none, from its client header (`<client>-<semver>`, the longest
 * semver from the right): encoded JSON for Convex's old npm, CLI and actions clients (before 1.4.1) and old
 * python ones (before 0.5.0), clean JSON for everyone else — a request with no header (curl) included.
 */
export function defaultFormat(clientHeader: string | null): Format {
  if (clientHeader === null) return "clean";
  const parts = clientHeader.split("-");
  let client = parts[0]!;
  let version: string | null = null;
  for (let n = 1; n < parts.length; n++) {
    const v = parts.slice(n).join("-");
    if (SEMVER.test(v)) {
      client = parts.slice(0, n).join("-");
      version = v;
      break;
    }
  }
  if (version === null) return "clean"; // an unrecognised version counts as a new one
  const threshold = (() => {
    switch (client.toLowerCase()) {
      case "npm":
      case "npm-cli":
      case "actions":
        return "1.4.1";
      case "python":
        return "0.5.0";
      default:
        return null;
    }
  })();
  return threshold !== null && Bun.semver.order(version, threshold) < 0 ? "encoded" : "clean";
}

/**
 * A value held as encoded JSON text (bunvex's wire form), rewritten in `format` as Convex writes it (floats
 * as `serde_json` does, `1.0`, `-0.0`). Encoded asks for no work; another format costs a parse and a write
 * (about 30 µs per KiB).
 */
export const reformat = (encodedJson: string, format: Format): string =>
  format === "encoded" ? encodedJson : writeValue(fromJsonValue(JSON.parse(encodedJson) as JSONValue), format);
