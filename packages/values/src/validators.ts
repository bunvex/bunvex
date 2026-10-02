// Validators (STUDY-13): `v.string()`, `v.id("tasks")`, `v.object({…})`… — the shapes an argument, a return
// value or a document must have, with the same builders, parts, JSON form and checking rules as Convex's
// (npm-packages/convex/src/values/validators.ts builds them; crates/common/src/schemas/validator.rs checks).
import { fromJsonValue, type JSONValue, toJsonValue, type Value } from "./value.ts";

export type OptionalProperty = "required" | "optional";

/**
 * A document's id in a table, as Convex's `GenericId`: a string branded with its table name, so ids of
 * different tables do not mix (STUDY-36). `_generated/dataModel` names it `Id<TableName>`.
 */
export type GenericId<TableName extends string> = string & { __tableName: TableName };

export type ValidatorJSON =
  | { type: "null" | "number" | "bigint" | "boolean" | "string" | "bytes" | "any" }
  | { type: "id"; tableName: string }
  | { type: "literal"; value: JSONValue }
  | { type: "array"; value: ValidatorJSON }
  | { type: "object"; value: Record<string, { fieldType: ValidatorJSON; optional: boolean }> }
  | { type: "record"; keys: ValidatorJSON; values: { fieldType: ValidatorJSON; optional: false } }
  | { type: "union"; value: ValidatorJSON[] };

abstract class BaseValidator<Type, IsOptional extends OptionalProperty> {
  /** Only for type inference (`Infer`); never set at runtime. */
  declare readonly type: Type;
  readonly isValidator = true as const;
  constructor(readonly isOptional: IsOptional) {}
  abstract readonly kind: string;
  abstract get json(): ValidatorJSON;
}

// biome-ignore lint/suspicious/noExplicitAny: a validator of any type (composite parts typed where used)
export type GenericValidator = Validator<any, OptionalProperty>;
/* biome-ignore-start lint/suspicious/noExplicitAny: the parts of composite validators, to keep the union non-circular */
export type Validator<Type, IsOptional extends OptionalProperty = OptionalProperty> =
  | VId<Type, IsOptional>
  | VString<Type, IsOptional>
  | VFloat64<Type, IsOptional>
  | VInt64<Type, IsOptional>
  | VBoolean<Type, IsOptional>
  | VNull<Type, IsOptional>
  | VBytes<Type, IsOptional>
  | VAny<Type, IsOptional>
  | VLiteral<Type, IsOptional>
  | VArray<Type, any, IsOptional>
  | VObject<Type, any, IsOptional>
  | VRecord<Type, any, any, IsOptional>
  | VUnion<Type, any[], IsOptional>;
/* biome-ignore-end lint/suspicious/noExplicitAny: see above */

/** The TypeScript type a validator accepts. */
export type Infer<T extends { type: unknown }> = T["type"];

export type PropertyValidators = { [field: string]: GenericValidator };
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;
type OptionalKeys<F extends PropertyValidators> = {
  [K in keyof F]: F[K]["isOptional"] extends "optional" ? K : never;
}[keyof F];
type RequiredKeys<F extends PropertyValidators> = Exclude<keyof F, OptionalKeys<F>>;
/** The object type a set of field validators describes (optional fields may be absent). */
export type ObjectType<F extends PropertyValidators> = Expand<
  { [K in RequiredKeys<F>]: Infer<F[K]> } & { [K in OptionalKeys<F>]?: Exclude<Infer<F[K]>, undefined> }
>;

export class VId<Type, IsOptional extends OptionalProperty = "required"> extends BaseValidator<Type, IsOptional> {
  readonly kind = "id" as const;
  constructor(
    isOptional: IsOptional,
    readonly tableName: string,
  ) {
    super(isOptional);
  }
  get json(): ValidatorJSON {
    return { type: "id", tableName: this.tableName };
  }
  optional() {
    return new VId<Type | undefined, "optional">("optional", this.tableName);
  }
}

export class VString<Type = string, IsOptional extends OptionalProperty = "required"> extends BaseValidator<
  Type,
  IsOptional
> {
  readonly kind = "string" as const;
  get json(): ValidatorJSON {
    return { type: "string" };
  }
  optional() {
    return new VString<Type | undefined, "optional">("optional");
  }
}

export class VFloat64<Type = number, IsOptional extends OptionalProperty = "required"> extends BaseValidator<
  Type,
  IsOptional
> {
  readonly kind = "float64" as const;
  get json(): ValidatorJSON {
    return { type: "number" };
  }
  optional() {
    return new VFloat64<Type | undefined, "optional">("optional");
  }
}

export class VInt64<Type = bigint, IsOptional extends OptionalProperty = "required"> extends BaseValidator<
  Type,
  IsOptional
> {
  readonly kind = "int64" as const;
  get json(): ValidatorJSON {
    return { type: "bigint" };
  }
  optional() {
    return new VInt64<Type | undefined, "optional">("optional");
  }
}

export class VBoolean<Type = boolean, IsOptional extends OptionalProperty = "required"> extends BaseValidator<
  Type,
  IsOptional
> {
  readonly kind = "boolean" as const;
  get json(): ValidatorJSON {
    return { type: "boolean" };
  }
  optional() {
    return new VBoolean<Type | undefined, "optional">("optional");
  }
}

export class VNull<Type = null, IsOptional extends OptionalProperty = "required"> extends BaseValidator<
  Type,
  IsOptional
> {
  readonly kind = "null" as const;
  get json(): ValidatorJSON {
    return { type: "null" };
  }
  optional() {
    return new VNull<Type | undefined, "optional">("optional");
  }
}

export class VBytes<Type = ArrayBuffer, IsOptional extends OptionalProperty = "required"> extends BaseValidator<
  Type,
  IsOptional
> {
  readonly kind = "bytes" as const;
  get json(): ValidatorJSON {
    return { type: "bytes" };
  }
  optional() {
    return new VBytes<Type | undefined, "optional">("optional");
  }
}

// biome-ignore lint/suspicious/noExplicitAny: v.any() accepts any value
export class VAny<Type = any, IsOptional extends OptionalProperty = "required"> extends BaseValidator<
  Type,
  IsOptional
> {
  readonly kind = "any" as const;
  get json(): ValidatorJSON {
    return { type: "any" };
  }
  optional() {
    return new VAny<Type | undefined, "optional">("optional");
  }
}

export class VLiteral<Type, IsOptional extends OptionalProperty = "required"> extends BaseValidator<Type, IsOptional> {
  readonly kind = "literal" as const;
  constructor(
    isOptional: IsOptional,
    readonly value: Type,
  ) {
    super(isOptional);
  }
  get json(): ValidatorJSON {
    return { type: "literal", value: toJsonValue(this.value as Value) };
  }
  optional() {
    return new VLiteral<Type | undefined, "optional">("optional", this.value);
  }
}

export class VArray<
  Type,
  Element extends GenericValidator,
  IsOptional extends OptionalProperty = "required",
> extends BaseValidator<Type, IsOptional> {
  readonly kind = "array" as const;
  constructor(
    isOptional: IsOptional,
    readonly element: Element,
  ) {
    super(isOptional);
  }
  get json(): ValidatorJSON {
    return { type: "array", value: this.element.json };
  }
  optional() {
    return new VArray<Type | undefined, Element, "optional">("optional", this.element);
  }
}

export class VObject<
  Type,
  Fields extends PropertyValidators,
  IsOptional extends OptionalProperty = "required",
> extends BaseValidator<Type, IsOptional> {
  readonly kind = "object" as const;
  constructor(
    isOptional: IsOptional,
    readonly fields: Fields,
  ) {
    super(isOptional);
    for (const [name, f] of Object.entries(fields))
      if (!f?.isValidator) throw new Error(`v.object() entries must be validators; the entry for "${name}" is not`);
  }
  get json(): ValidatorJSON {
    return {
      type: "object",
      value: Object.fromEntries(
        Object.entries(this.fields).map(([k, f]) => [k, { fieldType: f.json, optional: f.isOptional === "optional" }]),
      ),
    };
  }
  optional() {
    return new VObject<Type | undefined, Fields, "optional">("optional", this.fields);
  }
  /** A new object validator without the given fields. */
  omit<K extends keyof Fields & string>(...names: K[]) {
    const f = { ...this.fields };
    for (const n of names) delete f[n];
    return new VObject<ObjectType<Omit<Fields, K>>, Omit<Fields, K>, IsOptional>(this.isOptional, f);
  }
  /** A new object validator with only the given fields. */
  pick<K extends keyof Fields & string>(...names: K[]) {
    const f = {} as Pick<Fields, K>;
    for (const n of names) f[n] = this.fields[n];
    return new VObject<ObjectType<Pick<Fields, K>>, Pick<Fields, K>, IsOptional>(this.isOptional, f);
  }
  /** A new object validator with every field optional. */
  partial() {
    const f = Object.fromEntries(Object.entries(this.fields).map(([k, x]) => [k, optionalOf(x)])) as {
      [K in keyof Fields]: Validator<Infer<Fields[K]> | undefined, "optional">;
    };
    return new VObject<ObjectType<typeof f>, typeof f, IsOptional>(this.isOptional, f);
  }
  /** A new object validator with more fields (the new ones win). */
  extend<More extends PropertyValidators>(more: More) {
    const f = { ...this.fields, ...more } as unknown as Expand<Omit<Fields, keyof More> & More>;
    return new VObject<ObjectType<typeof f>, typeof f, IsOptional>(this.isOptional, f);
  }
}

export class VRecord<
  Type,
  Key extends GenericValidator,
  Val extends GenericValidator,
  IsOptional extends OptionalProperty = "required",
> extends BaseValidator<Type, IsOptional> {
  readonly kind = "record" as const;
  constructor(
    isOptional: IsOptional,
    readonly key: Key,
    readonly value: Val,
  ) {
    super(isOptional);
    if (key === undefined) throw new Error('A validator is undefined for field "key" in v.record().');
    if (value === undefined) throw new Error('A validator is undefined for field "value" in v.record().');
    if (!key.isValidator || !value.isValidator) throw new Error("Key and value of v.record() must be validators");
    if (key.isOptional === "optional") throw new Error("Record validator cannot have optional keys");
    if (value.isOptional === "optional") throw new Error("Record validator cannot have optional values");
  }
  get json(): ValidatorJSON {
    return { type: "record", keys: this.key.json, values: { fieldType: this.value.json, optional: false } };
  }
  optional() {
    return new VRecord<Type | undefined, Key, Val, "optional">("optional", this.key, this.value);
  }
}

export class VUnion<
  Type,
  Members extends GenericValidator[],
  IsOptional extends OptionalProperty = "required",
> extends BaseValidator<Type, IsOptional> {
  readonly kind = "union" as const;
  constructor(
    isOptional: IsOptional,
    readonly members: Members,
  ) {
    super(isOptional);
    for (const m of members) if (!m?.isValidator) throw new Error("All members of v.union() must be validators");
  }
  get json(): ValidatorJSON {
    return { type: "union", value: this.members.map((m) => m.json) };
  }
  optional() {
    return new VUnion<Type | undefined, Members, "optional">("optional", this.members);
  }
}

function optionalOf<V extends GenericValidator>(x: V): Validator<Infer<V> | undefined, "optional"> {
  return (x.isOptional === "optional" ? x : (x as { optional(): unknown }).optional()) as never;
}

type Required<V extends GenericValidator> = V extends { isOptional: "optional" } ? never : V;

/** The validator builders. */
export const v = {
  id: <TableName extends string>(tableName: TableName) => new VId<GenericId<TableName>>("required", tableName),
  null: () => new VNull("required"),
  number: () => new VFloat64("required"),
  float64: () => new VFloat64("required"),
  bigint: () => new VInt64("required"),
  int64: () => new VInt64("required"),
  boolean: () => new VBoolean("required"),
  string: () => new VString("required"),
  bytes: () => new VBytes("required"),
  literal: <T extends string | number | bigint | boolean>(value: T) => new VLiteral<T>("required", value),
  array: <E extends GenericValidator>(element: Required<E>) => new VArray<Infer<E>[], E>("required", element),
  object: <F extends PropertyValidators>(fields: F) => new VObject<ObjectType<F>, F>("required", fields),
  record: <K extends GenericValidator, V extends GenericValidator>(key: K, value: V) =>
    new VRecord<Record<Infer<K> & string, Infer<V>>, K, V>("required", key, value),
  union: <M extends GenericValidator[]>(...members: M) => new VUnion<Infer<M[number]>, M>("required", members),
  any: () => new VAny("required"),
  optional: <V extends GenericValidator>(x: V) => optionalOf(x) as ReturnType<typeof optionalOf<V>>,
  nullable: <V extends GenericValidator>(x: V) => v.union(x, v.null()),
};

/**
 * A validator from its JSON form (the inverse of `.json`): how a pushed schema, stored as Convex stores
 * it, becomes validators again (STUDY-35).
 */
export function validatorFromJson(j: ValidatorJSON): GenericValidator {
  switch (j.type) {
    case "null":
      return v.null();
    case "number":
      return v.number();
    case "bigint":
      return v.int64();
    case "boolean":
      return v.boolean();
    case "string":
      return v.string();
    case "bytes":
      return v.bytes();
    case "any":
      return v.any();
    case "id":
      return v.id(j.tableName);
    case "literal":
      return v.literal(fromJsonValue(j.value) as string | number | bigint | boolean);
    case "array":
      return v.array(validatorFromJson(j.value) as never);
    case "object":
      return v.object(
        Object.fromEntries(
          Object.entries(j.value).map(([k, f]) => {
            const x = validatorFromJson(f.fieldType);
            return [k, f.optional ? v.optional(x) : x];
          }),
        ) as never,
      );
    case "record":
      return v.record(validatorFromJson(j.keys), validatorFromJson(j.values.fieldType));
    case "union":
      return v.union(...j.value.map(validatorFromJson));
  }
}
