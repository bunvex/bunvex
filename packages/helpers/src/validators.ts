// convex-helpers' `validators.ts` (STUDY-181; get-convex/convex-helpers @ e48f9df, 0.1.128): validator builders
// (`literals`, `nullable`, `partial`, `doc`, `typedV`…), and checking and parsing values in JavaScript against a
// validator (`validate`, `parse`), with convex-helpers' names, signatures, behaviour and messages, over bunvex's
// `@bunvex/values` validators. Two names follow rule 5 (DV-544): convex-helpers reads a validator's
// `isConvexValidator`, bunvex's validators carry `isValidator`; its "Unknown Convex validator type: " is
// "Unknown validator type: ".
//
// bunvex's validators have no `fieldPaths` type parameter (Convex's third), so the types that carry one upstream
// (`AddFieldsToValidator`'s non-object case, `VRequired`) leave it out.
// biome-ignore-all lint/suspicious/noExplicitAny: the public signatures are convex-helpers', `any` included

import type {
  DataModelFromSchemaDefinition,
  GenericDatabaseReader,
  SchemaDefinition,
  SystemTableNames,
  TableNamesInDataModel,
} from "@bunvex/server";
import {
  asObjectValidator,
  type GenericId,
  type GenericValidator,
  type Infer,
  type ObjectType,
  type OptionalProperty,
  type PropertyValidators,
  type VAny,
  type VArray,
  type Validator,
  type VBoolean,
  type VBytes,
  type VCommitTs,
  type VFloat64,
  type VId,
  type VInt64,
  type VLiteral,
  type VNull,
  type VObject,
  type VOptional,
  type VRecord,
  type VString,
  type VUnion,
  v,
} from "@bunvex/values";
import { assert, type Expand } from "./index.ts";

/**
 * A union of literals: `literals("a", 1, false)` is `v.union(v.literal("a"), v.literal(1), v.literal(false))`, each
 * member typed with its own literal (`literals(...values)` takes an `as const` array too).
 */
export const literals = <T extends Array<string | number | boolean | bigint>>(...args: T) =>
  v.union(...args.map((value) => v.literal(value))) as VUnion<T[number], NoInfer<{ [K in keyof T]: VLiteral<T[K]> }>>;

/**
 * @deprecated Use `v.nullable` instead.
 * The value or `null`: `v.union(v.null(), x)`. `null` is the FIRST member (where `v.nullable` puts it last), which
 * shows in the validator's JSON and in the order a union's members are tried.
 */
export const nullable = <V extends Validator<any, "required">>(x: V) => v.union(v.null(), x);

/**
 * Every field optional: `partial({ a: v.string(), b: v.number() })` is
 * `{ a: v.optional(v.string()), b: v.optional(v.number()) }`.
 */
export function partial<T extends PropertyValidators>(obj: T): { [K in keyof T]: VOptional<T[K]> };
/**
 * @deprecated use `v.object(...).partial()` instead.
 * An object validator with every field optional: `partial(v.object({ a: v.string() }))` is
 * `v.object({ a: v.optional(v.string()) })`.
 */
export function partial<T, V extends Record<string, GenericValidator>, O extends OptionalProperty>(
  obj: VObject<T, V, O>,
): PartialVObject<T, V, O>;
/**
 * A union with every field of its object members optional, nested unions included:
 * `partial(v.union(v.object({ a: v.string() }), v.object({ b: v.number() })))` is
 * `v.union(v.object({ a: v.optional(v.string()) }), v.object({ b: v.optional(v.number()) }))`.
 */
export function partial<T, V extends Validator<T, "required">[], O extends OptionalProperty>(
  obj: VUnion<T, V, O>,
): PartialVUnion<T, V, O>;
/** An object or union validator with every field optional, as the overloads above. */
export function partial<Object extends VObject<any, any, any>, Union extends VUnion<any, any[], any>>(
  obj: Object | Union,
):
  | PartialVUnion<Union["type"], Union["members"], Object["isOptional"]>
  | PartialVObject<Object["type"], Object["fields"], Object["isOptional"]>;
export function partial(fieldsOrObjOrUnion: PropertyValidators | VObject<any, any, any> | VUnion<any, any[], any>) {
  if (!(fieldsOrObjOrUnion as GenericValidator).isValidator)
    return partialFields(fieldsOrObjOrUnion as PropertyValidators);
  const validator = fieldsOrObjOrUnion as GenericValidator;
  if (validator.kind === "object") return partialVObject(validator);
  if (validator.kind === "union") return partialUnion(validator);
  throw new Error("partial only works with union or object Validators, or a Record<string, Validator> currently");
}

/** The fields, each optional (one already optional kept as it is). */
function partialFields<T extends PropertyValidators>(obj: T): { [K in keyof T]: VOptional<T[K]> } {
  const out: Record<string, GenericValidator> = {};
  for (const [name, field] of Object.entries(obj))
    out[name] = field.isOptional === "optional" ? field : v.optional(field);
  return out as { [K in keyof T]: VOptional<T[K]> };
}

/** The object validator with its fields optional, itself optional if it was. */
function partialVObject<T, V extends Record<string, GenericValidator>, O extends OptionalProperty>(
  obj: VObject<T, V, O>,
): PartialVObject<T, V, O> {
  const object = v.object(partialFields(obj.fields));
  return (obj.isOptional === "optional" ? v.optional(object) : object) as any;
}

type PartialVObject<T, V extends Record<string, GenericValidator>, Optional extends OptionalProperty> = VObject<
  Partial<T>,
  { [K in keyof V]: VOptional<V[K]> },
  Optional
>;

type PartialUnionMembers<Members extends readonly Validator<any, "required">[]> = {
  [K in keyof Members]: Members[K] extends VObject<any, any, "required">
    ? Members[K] extends VObject<infer MemberT, infer MemberV extends PropertyValidators, "required">
      ? PartialVObject<MemberT, MemberV, "required">
      : Members[K]
    : Members[K] extends VUnion<any, any, "required">
      ? Members[K] extends VUnion<infer MemberT, infer MemberV extends Validator<any, "required">[], "required">
        ? PartialVUnion<MemberT, MemberV, "required">
        : Members[K]
      : Members[K];
};

/** The union with each member made partial: its objects and its unions (a member of another kind refused). */
function partialUnion<T, V extends Validator<T, "required">[], O extends OptionalProperty>(
  union: VUnion<T, V, O>,
): PartialVUnion<T, V, O> {
  const members = union.members.map((member: GenericValidator) => {
    assert(member.isOptional === "required", "Union members cannot be optional");
    if (member.kind === "object") return partialVObject(member) as VObject<any, any, "required">;
    if (member.kind === "union") return partialUnion(member) as VUnion<any, any[], "required">;
    throw new Error(`Invalid union member type: ${member.kind}`);
  });
  const partialUnionValidator = v.union(...members);
  return (union.isOptional === "optional" ? v.optional(partialUnionValidator) : partialUnionValidator) as any;
}

type PartialVUnion<T, Members extends Validator<T, "required">[], Optional extends OptionalProperty> = VUnion<
  Partial<T>,
  PartialUnionMembers<Members>,
  Optional
>;

/**
 * The validators of a table's system fields: `systemFields("users")` is
 * `{ _id: v.id("users"), _creationTime: v.number() }`.
 */
export const systemFields = <TableName extends string>(tableName: TableName) => ({
  _id: v.id(tableName),
  _creationTime: v.number(),
});

/** The type of `systemFields(tableName)`. */
export type SystemFields<TableName extends string> = ReturnType<typeof systemFields<TableName>>;

/**
 * @deprecated Use `schema.doc` or `docValidator` instead.
 * The fields with the system fields added: `withSystemFields("users", { name: v.string() })` is
 * `{ name: v.string(), _id: v.id("users"), _creationTime: v.number() }`.
 */
export const withSystemFields = <TableName extends string, T extends Record<string, GenericValidator>>(
  tableName: TableName,
  fields: T,
) => {
  const system = systemFields(tableName);
  return { ...fields, ...system } as Expand<T & typeof system>;
};

/** The validator `addFieldsToValidator(validator, fields)` makes. */
export type AddFieldsToValidator<V extends Validator<any, any>, Fields extends PropertyValidators> =
  V extends VObject<infer T, infer F, infer O>
    ? VObject<Expand<T & ObjectType<Fields>>, Expand<F & Fields>, O>
    : Validator<Expand<V["type"] & ObjectType<Fields>>, V["isOptional"]>;

/** `v.object({ ...validator, ...fields })`. */
export function addFieldsToValidator<Props extends PropertyValidators, Fields extends PropertyValidators>(
  validator: Props,
  fields: Fields,
): VObject<ObjectType<Props & Fields>, Props & Fields, "required">;
/** An object validator with more fields: `v.object({ ...validator.fields, ...fields })`. */
export function addFieldsToValidator<V extends VObject<any, any, any>, Fields extends PropertyValidators>(
  validator: V,
  fields: Fields,
): VObject<V["type"] & ObjectType<Fields>, V["fields"] & Fields, V["isOptional"]>;
/** A union validator with the fields added to each member: `v.union(...members.map((m) => addFieldsToValidator(m, fields)))`. */
export function addFieldsToValidator<V extends VUnion<any, any[], any>, Fields extends PropertyValidators>(
  validator: V,
  fields: Fields,
): AddFieldsToValidator<V, Fields>;
export function addFieldsToValidator<
  V extends VObject<any, any, any> | VUnion<any, any[], any>,
  Fields extends PropertyValidators,
>(validator: V, fields: Fields): AddFieldsToValidator<V, Fields>;
export function addFieldsToValidator<
  V extends PropertyValidators | VObject<any, any, any> | VUnion<any, any[], any>,
  Fields extends PropertyValidators,
>(validatorOrFields: V, fields: Fields): any {
  const validator = asObjectValidator(validatorOrFields) as GenericValidator;
  if (Object.keys(fields).length === 0) return validator;
  if (validator.kind === "object") return v.object(mergeFields(validator.fields, fields));
  if (validator.kind === "union")
    return v.union(...validator.members.map((member: GenericValidator) => addFieldsToValidator(member as any, fields)));
  throw new Error("Cannot add arguments to a validator that is not an object or union.");
}

/**
 * The fields of both: a field in both must be of the same kind, and the required one wins over an optional one
 * (otherwise the first's is kept).
 */
function mergeFields(fields: PropertyValidators, more: PropertyValidators): PropertyValidators {
  const merged: PropertyValidators = { ...fields };
  for (const [name, added] of Object.entries(more)) {
    const existing = merged[name];
    if (!existing) {
      merged[name] = added;
      continue;
    }
    if (existing.kind !== added.kind)
      throw new Error(`Cannot intersect validators with different kinds: ${existing.kind} and ${added.kind}`);
    if (existing.isOptional === "optional" && added.isOptional === "required") merged[name] = added;
  }
  return merged;
}

/**
 * @deprecated Use `schema.doc` instead.
 * The validator of a table's whole documents: its validator with `_id` and `_creationTime` added to its object, or
 * to each object of its union (recursively).
 */
export const doc = <
  Schema extends SchemaDefinition<any, boolean>,
  TableName extends TableNamesInDataModel<DataModelFromSchemaDefinition<Schema>>,
>(
  schema: Schema,
  tableName: TableName,
): AddFieldsToValidator<Schema["tables"][TableName]["validator"], SystemFields<TableName>> => {
  const withSystem = (validator: GenericValidator): any => {
    if (validator.kind === "object") return v.object({ ...validator.fields, ...systemFields(tableName) });
    if (validator.kind !== "union") throw new Error("Only object and union validators are supported for documents");
    return v.union(...validator.members.map(withSystem));
  };
  return withSystem(schema.tables[tableName].validator);
};

// convex-helpers' `id` takes the schema's tables only; the system tables (`_storage`, `_scheduled_functions`) are
// AD-23's, as `v.id` suggests them (AD-21).
/**
 * @deprecated Use `schema.doc` and `schema.id` instead.
 * `v` for a schema's functions: `id(table)` limited to the schema's tables and the system tables, and `doc(table)`, the
 * validator of a table's whole documents. For `args` and `returns`; a schema cannot use it (it would be circular).
 * Types only: at run time it is `v.id`.
 */
export function typedV<Schema extends SchemaDefinition<any, boolean>>(
  schema: Schema,
): Omit<typeof v, "id"> & {
  id: <TableName extends TableNamesInDataModel<DataModelFromSchemaDefinition<Schema>> | SystemTableNames>(
    tableName: TableName,
  ) => VId<GenericId<TableName>, "required">;
  doc: <TableName extends TableNamesInDataModel<DataModelFromSchemaDefinition<Schema>>>(
    tableName: TableName,
  ) => AddFieldsToValidator<Schema["tables"][TableName]["validator"], SystemFields<TableName>>;
} {
  return {
    ...v,
    /** `v.id`, its table one of the schema's or a system table. */
    id: (tableName) => v.id(tableName),
    /** The validator of the table's whole documents, system fields included (`doc(schema, tableName)`). */
    doc: (tableName) => doc(schema, tableName),
  };
}

/**
 * A string validator typed as a branded string (`string & { _: T }`), so values of different brands do not mix.
 * @param _brand - The brand, a string literal.
 */
export const brandedString = <T extends string>(_brand: T) => v.string() as VString<string & { _: T }>;

/** A deprecated field: accepts anything (or nothing), typed as `null`. */
export const deprecated = v.optional(v.any()) as Validator<null, "optional">;

/**
 * A validator that accepts anything (or nothing) and is typed as the given one: for data that does not match its
 * type yet, without checking it.
 */
export const pretend = <T extends GenericValidator>(_typeToImmitate: T): T => v.optional(v.any()) as T;

/**
 * The validator, optional at run time but typed as required: for a field being added, before every document has it.
 * Unlike `pretend`, a value that is there is checked.
 */
export const pretendRequired = <T extends Validator<any, "required">>(optionalType: T): T =>
  v.optional(optionalType) as unknown as T;

/** What `validate` (with `throw: true`) and `parse` throw: the kind expected, what was got, and where. */
export class ValidationError extends Error {
  constructor(
    public expected: string,
    public got: string,
    public path?: string,
  ) {
    super(`Validator error${path ? ` for ${path}` : ""}: Expected \`${expected}\`, got \`${got}\``);
    this.name = "ValidationError";
  }
}

/**
 * Whether the value matches the validator, checked in JavaScript.
 *
 * Without `db`, an id is only checked to be a string; with `db` (a query's or mutation's `ctx.db`), it must be an id of
 * the validator's table (`db.normalizeId`, or `db.system.normalizeId` for a system table). Only own properties count
 * as an object's fields, and unknown fields are refused unless `allowUnknownFields` (fields set to `undefined` are
 * ignored, as they are stripped). With `throw`, a mismatch throws a `ValidationError` instead of returning false.
 */
export function validate<T extends Validator<any, any>>(
  validator: T,
  value: unknown,
  opts?: {
    /** Throw a `ValidationError` when the value does not match. */
    throw?: boolean;
    /** Check ids against their table: any database reader, e.g. a query's or mutation's `ctx.db`. */
    db?: GenericDatabaseReader<any>;
    /** Accept fields an object validator does not declare. */
    allowUnknownFields?: boolean;
    /** The path of the value checked, for errors: set by the recursive calls, never by a caller. */
    _pathPrefix?: string;
  },
): value is T["type"] {
  const checked = validator as GenericValidator;
  let valid = true;
  let expected: string = checked.kind;
  let got: string | undefined;
  if (value === undefined) {
    if (checked.isOptional !== "optional") valid = false;
  } else {
    switch (checked.kind) {
      case "null":
        if (value !== null) valid = false;
        break;
      case "float64":
        if (typeof value !== "number") {
          expected = "number";
          valid = false;
        }
        break;
      case "int64":
        if (typeof value !== "bigint") {
          expected = "bigint";
          valid = false;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") valid = false;
        break;
      case "string":
        if (typeof value !== "string") valid = false;
        break;
      case "bytes":
        if (!(value instanceof ArrayBuffer)) valid = false;
        break;
      case "any":
        break;
      case "literal":
        if (value !== checked.value) {
          valid = false;
          // The literal as it is (a number stays a number on the error), as convex-helpers.
          expected = checked.value as string;
          if (["string", "number", "boolean", "bigint"].includes(typeof value)) got = `"${value}"`;
        }
        break;
      case "id":
        if (typeof value !== "string") valid = false;
        else if (opts?.db) {
          expected = `Id<${checked.tableName}>`;
          // A system table's ids are read through `db.system` only.
          const id = checked.tableName.startsWith("_")
            ? opts.db.system.normalizeId(checked.tableName as SystemTableNames, value)
            : opts.db.normalizeId(checked.tableName, value);
          if (!id) valid = false;
        }
        break;
      case "array":
        if (!Array.isArray(value)) {
          valid = false;
          break;
        }
        for (const [index, element] of value.entries()) {
          valid = validate(checked.element, element, { ...opts, _pathPrefix: `${opts?._pathPrefix ?? ""}[${index}]` });
          if (!valid) {
            expected = checked.element.kind;
            break;
          }
        }
        break;
      case "object": {
        if (typeof value !== "object" || value === null) {
          valid = false;
          break;
        }
        const prototype = Object.getPrototypeOf(value);
        // A plain object, made here or in another realm (a `vm` context's objects have another `Object`).
        const plain = prototype === null || prototype === Object.prototype || prototype?.constructor?.name === "Object";
        if (!plain) {
          expected = (prototype?.constructor?.name ?? typeof prototype) || "object";
          valid = false;
          break;
        }
        const record = value as Record<string, unknown>;
        for (const [name, field] of Object.entries(checked.fields as PropertyValidators)) {
          valid = validate(field, Object.hasOwn(record, name) ? record[name] : undefined, {
            ...opts,
            _pathPrefix: appendPath(opts, name),
          });
          if (!valid) break;
        }
        if (!opts?.allowUnknownFields) {
          for (const name of Object.keys(record)) {
            if (Object.hasOwn(checked.fields, name) || record[name] === undefined) continue;
            if (opts?.throw) throw new ValidationError("nothing", typeof record[name], appendPath(opts, name));
            valid = false;
            break;
          }
        }
        break;
      }
      case "union": {
        valid = false;
        let error: ValidationError | undefined;
        for (const member of checked.members as GenericValidator[]) {
          try {
            if (validate(member, value, opts)) {
              valid = true;
              break;
            }
          } catch (e) {
            error = e as ValidationError;
          }
        }
        // With `throw`, the last member's error.
        if (!valid && error) throw error;
        break;
      }
      case "record": {
        if (typeof value !== "object" || value === null) {
          valid = false;
          break;
        }
        for (const [key, fieldValue] of Object.entries(value)) {
          // A key set to `undefined` is stripped, so it is not checked.
          if (fieldValue === undefined) continue;
          valid = validate(checked.key, key, { ...opts, _pathPrefix: appendPath(opts, key) });
          if (!valid) {
            expected = checked.key.kind;
            break;
          }
          valid = validate(checked.value, fieldValue, { ...opts, _pathPrefix: appendPath(opts, key) });
          if (!valid) {
            expected = checked.value.kind;
            break;
          }
        }
        break;
      }
    }
  }
  if (!valid && opts?.throw)
    throw new ValidationError(expected, got ?? (value === null ? "null" : typeof value), opts?._pathPrefix);
  return valid;
}

/**
 * The value checked against the validator and copied without the fields it does not declare (where `validate`
 * refuses them). A union takes the first member that matches strictly, else the first that matches with unknown
 * fields. Throws a `ValidationError` when the value does not match.
 *
 * @param validator - The validator to parse the value against.
 * @param value - The value to parse.
 * @returns The value without the fields the validator does not declare.
 */
export function parse<T extends Validator<any, any>>(validator: T, value: unknown): Infer<T> {
  validate(validator, value, { allowUnknownFields: true, throw: true });
  return stripUnknownFields(validator, value);
}

/** The value (already checked) with only what the validator declares, every key an own one. */
function stripUnknownFields(validator: GenericValidator, value: any): any {
  if (validator.isOptional === "optional" && value === undefined) return value;
  assert(value !== undefined);
  switch (validator.kind) {
    case "object": {
      const fields = validator.fields as PropertyValidators;
      const result = {};
      for (const [name, fieldValue] of Object.entries(value)) {
        const field = Object.hasOwn(fields, name) ? fields[name] : undefined;
        if (field !== undefined && fieldValue !== undefined)
          defineOwn(result, name, stripUnknownFields(field, fieldValue));
      }
      return result;
    }
    case "record": {
      const result = {};
      for (const [key, fieldValue] of Object.entries(value))
        if (fieldValue !== undefined) defineOwn(result, key, stripUnknownFields(validator.value, fieldValue));
      return result;
    }
    case "array":
      return (value as unknown[]).map((element) => stripUnknownFields(validator.element, element));
    case "union": {
      const members = validator.members as GenericValidator[];
      for (const member of members)
        if (validate(member, value, { allowUnknownFields: false })) return stripUnknownFields(member, value);
      for (const member of members)
        if (validate(member, value, { allowUnknownFields: true })) return stripUnknownFields(member, value);
      throw new Error("No matching member in union");
    }
    default:
      return value;
  }
}

/** Set an own, enumerable key: assigning `__proto__` would set the prototype instead. */
function defineOwn(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function appendPath(opts: { _pathPrefix?: string } | undefined, path: string) {
  return opts?._pathPrefix ? `${opts._pathPrefix}.${path}` : path;
}

type NotUndefined<T> = Exclude<T, undefined>;

/**
 * The required validator of an optional one (the inverse of `VOptional`): `VRequired<VOptional<VString>>` is
 * `VString<string, "required">`.
 */
export type VRequired<T extends Validator<any, OptionalProperty>> =
  T extends VId<infer Type, OptionalProperty>
    ? VId<NotUndefined<Type>, "required">
    : T extends VString<infer Type, OptionalProperty>
      ? VString<NotUndefined<Type>, "required">
      : T extends VFloat64<infer Type, OptionalProperty>
        ? VFloat64<NotUndefined<Type>, "required">
        : T extends VInt64<infer Type, OptionalProperty>
          ? VInt64<NotUndefined<Type>, "required">
          : T extends VCommitTs<infer Type, OptionalProperty>
            ? VCommitTs<NotUndefined<Type>, "required">
            : T extends VBoolean<infer Type, OptionalProperty>
              ? VBoolean<NotUndefined<Type>, "required">
              : T extends VNull<infer Type, OptionalProperty>
                ? VNull<NotUndefined<Type>, "required">
                : T extends VAny<infer Type, OptionalProperty>
                  ? VAny<NotUndefined<Type>, "required">
                  : T extends VLiteral<infer Type, OptionalProperty>
                    ? VLiteral<NotUndefined<Type>, "required">
                    : T extends VBytes<infer Type, OptionalProperty>
                      ? VBytes<NotUndefined<Type>, "required">
                      : T extends VObject<infer Type, infer Fields, OptionalProperty>
                        ? VObject<NotUndefined<Type>, Fields, "required">
                        : T extends VArray<infer Type, infer Element, OptionalProperty>
                          ? VArray<NotUndefined<Type>, Element, "required">
                          : T extends VRecord<infer Type, infer Key, infer Value, OptionalProperty>
                            ? VRecord<NotUndefined<Type>, Key, Value, "required">
                            : T extends VUnion<infer Type, infer Members, OptionalProperty>
                              ? VUnion<NotUndefined<Type>, Members, "required">
                              : never;

/**
 * The required validator of an optional one (the inverse of `v.optional`); a required validator is returned as it
 * is: `vRequired(v.optional(v.string()))` is `v.string()`.
 */
export function vRequired<T extends Validator<any, OptionalProperty>>(validator: T): VRequired<T> {
  const checked = validator as GenericValidator;
  if (checked.isOptional === "required") return validator as unknown as VRequired<T>;
  let required: GenericValidator;
  switch (checked.kind) {
    case "id":
      required = v.id(checked.tableName);
      break;
    case "string":
      required = v.string();
      break;
    case "float64":
      required = v.float64();
      break;
    case "int64":
      required = v.int64();
      break;
    case "boolean":
      required = v.boolean();
      break;
    case "null":
      required = v.null();
      break;
    case "any":
      required = v.any();
      break;
    case "literal":
      required = v.literal(checked.value as string | number | bigint | boolean);
      break;
    case "bytes":
      required = v.bytes();
      break;
    case "object":
      required = v.object(checked.fields as PropertyValidators);
      break;
    case "array":
      required = v.array(checked.element as never);
      break;
    case "record":
      required = v.record(checked.key as never, checked.value as never);
      break;
    case "union":
      required = v.union(...(checked.members as never[]));
      break;
    case "commitTs":
      required = v.commitTs();
      break;
    default: {
      const kind: never = checked;
      throw new Error(`Unknown validator type: ${(kind as GenericValidator).kind}`);
    }
  }
  return required as unknown as VRequired<T>;
}
