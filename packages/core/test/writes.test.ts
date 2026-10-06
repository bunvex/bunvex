import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const schema = defineSchema({ items: defineTable(v.any()) });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}

describe("writes: replace, nonexistent documents, Convex's limits", () => {
  test("replace swaps every non-system field and keeps _id / _creationTime", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("items", { a: 1, b: 2 }));
    const before = (await e.query((db) => db.get("items", id))) as Doc;
    await e.mutation((db) => db.replace("items", id, { c: 3 }));
    const after = (await e.query((db) => db.get("items", id))) as Doc;
    expect(after).toEqual({ _creationTime: before._creationTime, _id: id, c: 3 });
    await e.mutation((db) => db.replace("items", id, { _id: id, d: 4 })); // the same _id is accepted
    await expect(e.mutation((db) => db.replace("items", id, { _creationTime: 1 }))).rejects.toThrow(
      "doesn't match '_creationTime' field",
    );
  });

  test("patch / replace / delete of a document that does not exist fail with Convex's messages", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("items", {}));
    await e.mutation((db) => db.delete("items", id));
    await expect(e.mutation((db) => db.patch("items", id, { a: 1 }))).rejects.toThrow(
      `Update on nonexistent document ID ${id}`,
    );
    await expect(e.mutation((db) => db.replace("items", id, {}))).rejects.toThrow(
      `Replace on nonexistent document ID ${id}`,
    );
    await expect(e.mutation((db) => db.delete("items", id))).rejects.toThrow(`Delete on nonexistent document ID ${id}`);
  });

  test("a document over 1 MiB is refused", async () => {
    const e = await engine();
    await expect(e.mutation((db) => db.insert("items", { big: "x".repeat(1_100_000) }))).rejects.toThrow(
      "Value is too large (1.05 MiB > maximum size 1 MiB)",
    );
    await e.mutation((db) => db.insert("items", { ok: "x".repeat(1_000_000) }));
  });

  test("nesting deeper than 16, arrays over 8192 and objects over 1024 fields are refused", async () => {
    const e = await engine();
    let deep: unknown = 1;
    for (let i = 0; i < 16; i++) deep = [deep]; // the document itself adds a level: 17
    await expect(e.mutation((db) => db.insert("items", { deep }))).rejects.toThrow(
      "Document is too nested (nested 17 levels deep > maximum nesting 16)",
    );
    await expect(e.mutation((db) => db.insert("items", { list: new Array(8193).fill(0) }))).rejects.toThrow(
      "Array length is too long (8193 > maximum length 8192)",
    );
    const wide = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`f${i}`, 0]));
    await expect(e.mutation((db) => db.insert("items", { wide }))).rejects.toThrow(
      "Object has too many fields (1025 > maximum number 1024)",
    );
  });

  // Found by the differential tests (STUDY-122 phase 3). A written value is parsed in Convex's syscall under
  // `with_argument_error` (an array or object past its size is "Invalid argument `value` for `db.<method>`"),
  // then the document is checked by `ResolvedDocument::must_validate`: its display, then every violation.
  describe("the limits' messages, exactly as Convex's", () => {
    const message = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("did not fail");
    };
    const nest = (n: number): unknown => (n === 0 ? 1 : { d: nest(n - 1) });
    /** The start of Convex's message: the document's display, its system fields first (`<ct>`, `<id>`). */
    const docStart = (fields: string) =>
      new RegExp(
        `^Document\\(value: \\{${fields
          .replace("<ct>", "_creationTime: \\d+\\.\\d+")
          .replace("<id>", '_id: "[0-9a-z]+"')}`,
      );
    const UNDERSCORE = (f: string) =>
      `Field '${f}' starts with an underscore, which is only allowed for system fields like '_id'`;

    test("a value past an array's or an object's size: the argument's message, for each method", async () => {
      const e = await engine();
      const id = await e.mutation((db) => db.insert("items", {}));
      const list = new Array(8193).fill(0);
      const wide = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`f${i}`, 0]));
      const LONG = "Array length is too long (8193 > maximum length 8192)";
      const WIDE = "Object has too many fields (1025 > maximum number 1024)";
      expect(await message(e.mutation((db) => db.insert("items", { list })))).toBe(
        `Invalid argument \`value\` for \`db.insert\`: ${LONG}`,
      );
      expect(await message(e.mutation((db) => db.patch("items", id, { list })))).toBe(
        `Invalid argument \`value\` for \`db.patch\`: ${LONG}`,
      );
      expect(await message(e.mutation((db) => db.replace("items", id, { wide })))).toBe(
        `Invalid argument \`value\` for \`db.replace\`: ${WIDE}`,
      );
      expect(await message(e.mutation((db) => db.insert("items", wide)))).toBe(
        `Invalid argument \`value\` for \`db.insert\`: ${WIDE}`,
      );
    });

    test("a document too nested or with an underscore field: its display, then each violation", async () => {
      const e = await engine();
      const id = await e.mutation((db) => db.insert("items", { k: "a" }));
      const nested = await message(e.mutation((db) => db.insert("items", { deep: nest(17) })));
      expect(nested).toMatch(docStart("<ct>, <id>, deep: \\{d: \\{d: "));
      expect(nested).toEndWith(
        "1.0}}}}}}}}}}}}}}}}}}) isn't a valid document: Document is too nested (nested 18 levels deep > maximum nesting 16)",
      );
      const under = await message(e.mutation((db) => db.patch("items", id, { _bad: 1 })));
      // Fields in byte order, as a Convex object's: `_bad` sorts before `_creationTime`.
      expect(under).toMatch(docStart('_bad: 1\\.0, <ct>, <id>, k: "a"\\}\\) '));
      expect(under).toEndWith(`isn't a valid document: ${UNDERSCORE("_bad")}`);
      // Every violation, nesting first, then the system fields in field order, joined as Convex joins them.
      const both = await message(e.mutation((db) => db.replace("items", id, { _z: 1, _a: nest(17) })));
      expect(both).toEndWith(
        `isn't a valid document: Document is too nested (nested 18 levels deep > maximum nesting 16)\n ${UNDERSCORE("_a")}\n ${UNDERSCORE("_z")}`,
      );
      expect(await e.query((db) => db.query("items").collect())).toHaveLength(1);
    });
  });

  test("a mutation may write at most 16000 documents and 16 MiB", async () => {
    const e = await engine();
    await expect(
      e.mutation(async (db) => {
        for (let i = 0; i < 16_001; i++) await db.insert("items", { i });
      }),
    ).rejects.toThrow("Too many writes in a single function execution (limit: 16000)");
    await expect(
      e.mutation(async (db) => {
        for (let i = 0; i < 17; i++) await db.insert("items", { s: "x".repeat(1_000_000) });
      }),
    ).rejects.toThrow("Too many bytes written in a single function execution (limit: 16 MiB)");
    expect(await e.query((db) => db.query("items").collect())).toHaveLength(0);
  });

  describe("a written value nested past 64 levels (STUDY-109)", () => {
    /** A value nested `n` levels: objects and arrays in turn around a leaf. */
    const deep = (n: number): unknown => {
      let v: unknown = 1;
      for (let i = 0; i < n; i++) v = i % 2 ? [v] : { a: v };
      return v;
    };
    const tooNested = (method: string) =>
      `Invalid argument \`value\` for \`db.${method}\`: Value is too nested (nested 65 levels deep > maximum nesting 64)`;
    const docTooNested = (n: number) => `Document is too nested (nested ${n} levels deep > maximum nesting 16)`;

    test("insert and replace: 65 levels is the value's message, 64 the document's (Convex's order)", async () => {
      const e = await engine();
      const id = await e.mutation((db) => db.insert("items", {}));
      // The written value is the outermost level: `{x: deep(63)}` is 64, `{x: deep(64)}` 65.
      await expect(e.mutation((db) => db.insert("items", { x: deep(64) }))).rejects.toThrow(tooNested("insert"));
      await expect(e.mutation((db) => db.insert("items", { x: deep(63) }))).rejects.toThrow(docTooNested(64));
      await expect(e.mutation((db) => db.replace("items", id, { x: deep(64) }))).rejects.toThrow(tooNested("replace"));
      await expect(e.mutation((db) => db.replace("items", id, { x: deep(63) }))).rejects.toThrow(docTooNested(64));
    });

    test("patch: each field's value may nest 64 levels, as Convex parses them one by one", async () => {
      const e = await engine();
      const id = await e.mutation((db) => db.insert("items", {}));
      await expect(e.mutation((db) => db.patch("items", id, { x: deep(65) }))).rejects.toThrow(tooNested("patch"));
      await expect(e.mutation((db) => db.patch("items", id, { x: deep(64) }))).rejects.toThrow(docTooNested(65));
    });

    test("the value is checked before the table and the document are looked at", async () => {
      const e = await engine();
      const id = await e.mutation((db) => db.insert("items", {}));
      await e.mutation((db) => db.delete("items", id));
      // A table name that is not valid, and a document that does not exist: the value speaks first.
      await expect(e.mutation((db) => db.insert("_nope", { x: deep(64) }))).rejects.toThrow(tooNested("insert"));
      await expect(e.mutation((db) => db.patch("items", id, { x: deep(65) }))).rejects.toThrow(tooNested("patch"));
      await expect(e.mutation((db) => db.replace("items", id, { x: deep(64) }))).rejects.toThrow(tooNested("replace"));
    });

    test("100 000 levels fail with the message, not a stack overflow, and nothing is written", async () => {
      const e = await engine();
      const v = deep(100_000);
      await expect(
        e.mutation(async (db) => {
          await db.insert("items", { ok: 1 });
          await db.insert("items", { v });
        }),
      ).rejects.toThrow(tooNested("insert"));
      const id = await e.mutation((db) => db.insert("items", {}));
      await expect(e.mutation((db) => db.patch("items", id, { v }))).rejects.toThrow(tooNested("patch"));
      await expect(e.mutation((db) => db.replace("items", id, { v }))).rejects.toThrow(tooNested("replace"));
      expect(await e.query((db) => db.query("items").collect())).toHaveLength(1);
    });
  });
});
