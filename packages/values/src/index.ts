// Package @bunvex/values — Validators (v.string(), v.id()…), table-tagged ids and value types shared by client and server.

export * as Base64 from "./base64.ts";
export { checkValue, displayValidator, displayValue, type TableOfId } from "./check.ts";
export {
  CommitTsPlaceholder,
  commitTsPlaceholder,
  hasCommitTs,
  isCommitTsPlaceholder,
  MAX_COMMIT_TS,
  resolveCommitTs,
  resolveCommitTsJson,
} from "./commit-ts.ts";
export { BunvexError, isBunvexError } from "./errors.ts";
export { formatExportFloat, fromExportJson, toExportJson } from "./export-json.ts";
export { type DecodedId, decodeId, encodeId, IdDecodeError, idTableNumber } from "./id.ts";
export { keyBytesLength, valuesToKey } from "./sorting.ts";
export {
  type GenericId,
  type GenericValidator,
  type Infer,
  type ObjectType,
  type OptionalProperty,
  type PropertyValidators,
  VAny,
  VArray,
  type Validator,
  type ValidatorJSON,
  VBoolean,
  VBytes,
  VCommitTs,
  VFloat64,
  VId,
  VInt64,
  VLiteral,
  VNull,
  VObject,
  VRecord,
  VString,
  VUnion,
  v,
  validatorFromJson,
} from "./validators.ts";
export {
  compareValues,
  copyValue,
  fromJsonValue,
  getDocumentSize,
  isBytes,
  isSimpleObject,
  isSpecialFloat,
  type JSONValue,
  rawValueSize,
  stringifyValueForError,
  toJsonValue,
  type Value,
  validateObjectField,
  valueNesting,
  valueSize,
} from "./value.ts";
