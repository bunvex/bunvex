// Package @bunvex/values — Validators (v.string(), v.id()…), table-tagged ids and value types shared by client and server.
export { type DecodedId, decodeId, encodeId, IdDecodeError, idTableNumber } from "./id.ts";
export { valuesToKey } from "./sorting.ts";
export {
  compareValues,
  copyValue,
  fromJsonValue,
  isSimpleObject,
  isSpecialFloat,
  type JSONValue,
  stringifyValueForError,
  toJsonValue,
  type Value,
  validateObjectField,
} from "./value.ts";
