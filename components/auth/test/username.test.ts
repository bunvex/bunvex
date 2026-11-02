// The username component's suite (STUDY-201 §3.4), upstream's `components/username/username.test.ts` ported: its
// functions pushed as an app's (fixtures/username), so `t.run` reads its table.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api and the inline functions' ctx are untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { validateUsernameFormat } from "../src/components/username/validation.ts";

const api = anyApi as any;
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
// Each test pushes a deployment of its own; under a full `bun run check` a push can take past the default 5 s.
setDefaultTimeout(60_000);

function setup(): TestBunvex {
  const t = bunvexTest({ cwd: join(import.meta.dir, "fixtures", "username") });
  open.push(t);
  return t;
}

const setUsername = (t: TestBunvex, userId: string, username: string) =>
  t.mutation(api.public.setUsername, { userId, username });
const getUsername = (t: TestBunvex, userId: string) => t.query(api.public.getUsername, { userId });
const getUserIdByUsername = (t: TestBunvex, username: string) => t.query(api.public.getUserIdByUsername, { username });

describe("setUsername", () => {
  test("sets a username for a user with no username", async () => {
    const t = setup();
    expect(await setUsername(t, "user1", "Alice")).toEqual({ success: true, previousUsername: null });
    expect(await getUsername(t, "user1")).toBe("Alice");
  });

  test("renames a user and returns the previous username", async () => {
    const t = setup();
    await setUsername(t, "user1", "Alice");
    expect(await setUsername(t, "user1", "Bob")).toEqual({ success: true, previousUsername: "Alice" });

    // Only one row exists for the user, and the old username is free.
    expect(await t.run(async (ctx: any) => (await ctx.db.query("usernames").collect()).length)).toBe(1);
    expect(await getUserIdByUsername(t, "alice")).toBe(null);
    expect(await getUserIdByUsername(t, "bob")).toBe("user1");
  });

  test("keeps the new spelling when the same user sets the same username", async () => {
    const t = setup();
    await setUsername(t, "user1", "alice");
    expect(await setUsername(t, "user1", "ALICE")).toEqual({ success: true, previousUsername: "alice" });
    expect(await getUsername(t, "user1")).toBe("ALICE");
  });

  test("rejects a username that a different user has", async () => {
    const t = setup();
    await setUsername(t, "user1", "alice");
    expect(await setUsername(t, "user2", "alice")).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
    expect(await getUsername(t, "user2")).toBe(null);
  });

  test("rejects a username that a different user has, in a different case", async () => {
    const t = setup();
    await setUsername(t, "user1", "Alice");
    expect(await setUsername(t, "user2", "ALICE")).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("rejects an empty username", async () => {
    const t = setup();
    expect(await setUsername(t, "user1", "")).toEqual({
      success: false,
      userError: { error: "USERNAME_TOO_SHORT", minimumLength: 1 },
    });
  });

  test("accepts a one-character username and a very long username", async () => {
    const t = setup();
    expect(await setUsername(t, "user1", "a")).toEqual({ success: true, previousUsername: null });
    const long = "b".repeat(5000);
    expect(await setUsername(t, "user2", long)).toEqual({ success: true, previousUsername: null });
    expect(await getUserIdByUsername(t, long)).toBe("user2");
  });

  test("rejects a username with surrounding whitespace", async () => {
    const t = setup();
    for (const username of [" alice", "alice ", "\talice", "alice　"])
      expect(await setUsername(t, "user1", username)).toEqual({
        success: false,
        userError: { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" },
      });
  });

  test("rejects a username that is only whitespace", async () => {
    const t = setup();
    expect(await setUsername(t, "user1", " ")).toEqual({
      success: false,
      userError: { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" },
    });
  });

  test("accepts a space inside the username", async () => {
    const t = setup();
    expect(await setUsername(t, "user1", "alice smith")).toEqual({ success: true, previousUsername: null });
  });

  test("rejects malformed characters", async () => {
    const t = setup();
    const malformed = {
      "a NUL character": "ali\u0000ce",
      "a line feed": "ali\nce",
      "a delete character": "ali\u007fce",
      "a C1 control": "ali\u009dce",
      "a right-to-left override": "ali‮ce",
      "a zero-width space": "ali​ce",
      "a byte order mark": "ali﻿ce",
      "a no-break space": "ali ce",
      "an ideographic space": "ali　ce",
      "a noncharacter": "ali￾ce",
      "a plane-end noncharacter": "ali\u{1fffe}ce",
      "a leading combining mark": "́alice",
    };
    for (const [description, username] of Object.entries(malformed))
      expect({ description, result: await setUsername(t, "user1", username) }).toEqual({
        description,
        result: { success: false, userError: { error: "USERNAME_HAS_INVALID_CHARACTERS" } },
      });
  });

  // A lone surrogate does not cross the wire: a deployment refuses the call's arguments before the function runs, as
  // Convex's backend does (convex-test passes them through). The rule still refuses one.
  test("refuses an unpaired surrogate", async () => {
    const t = setup();
    await expect(setUsername(t, "user1", "ali\ud800ce")).rejects.toThrow("Invalid arguments provided");
    expect(validateUsernameFormat("ali\ud800ce")).toEqual({ error: "USERNAME_HAS_INVALID_CHARACTERS" });
  });

  test("accepts usernames of all scripts", async () => {
    const t = setup();
    const accepted = [
      "أحمد", // Arabic
      "中文名", // Chinese
      "Алиса", // Cyrillic
      "ひらがな", // Japanese
      "Renée-Élise",
      "user_name.42",
      // Some scripts and emoji sequences need the zero-width joiner, so it stays allowed.
      "family\u{1f468}‍\u{1f469}‍\u{1f466}",
    ];
    let userId = 0;
    for (const username of accepted)
      expect({ username, result: await setUsername(t, `user${userId++}`, username) }).toEqual({
        username,
        result: { success: true, previousUsername: null },
      });
  });

  test("counts an astral character as one character", async () => {
    const t = setup();
    // A single emoji is two UTF-16 units but one code point.
    expect(await setUsername(t, "user1", "😀")).toEqual({ success: true, previousUsername: null });
  });
});

describe("Unicode normalization", () => {
  // "café" spelled two ways: composed é (U+00E9) and decomposed e + combining acute (U+0301).
  const composed = "café";
  const decomposed = "café";

  test("finds a user across differing normalization forms", async () => {
    const t = setup();
    expect(composed).not.toBe(decomposed);
    await setUsername(t, "user1", composed);
    expect(await getUserIdByUsername(t, decomposed)).toBe("user1");
  });

  test("rejects the same username in a different normalization form", async () => {
    const t = setup();
    await setUsername(t, "user1", composed);
    expect(await setUsername(t, "user2", decomposed)).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("stores the username as the user supplied it", async () => {
    const t = setup();
    await setUsername(t, "user1", "AlIcE");
    const row = await t.run(async (ctx: any) => await ctx.db.query("usernames").unique());
    expect(row?.username).toBe("AlIcE");
    expect(row?.usernameNormalized).toBe("alice");
  });
});

describe("getUserIdByUsername", () => {
  test("ignores the case of the argument", async () => {
    const t = setup();
    await setUsername(t, "user1", "Alice");
    expect(await getUserIdByUsername(t, "ALICE")).toBe("user1");
    expect(await getUserIdByUsername(t, "alice")).toBe("user1");
  });

  test("returns null for an unknown username", async () => {
    const t = setup();
    expect(await getUserIdByUsername(t, "nobody")).toBe(null);
  });
});

describe("getUsername", () => {
  test("returns null for a user with no username", async () => {
    const t = setup();
    expect(await getUsername(t, "nobody")).toBe(null);
  });
});

describe("deleteUsername", () => {
  test("deletes the username of a user", async () => {
    const t = setup();
    await setUsername(t, "user1", "alice");
    expect(await t.mutation(api.public.deleteUsername, { userId: "user1" })).toEqual({ deleted: true });
    expect(await getUsername(t, "user1")).toBe(null);
    expect(await getUserIdByUsername(t, "alice")).toBe(null);
  });

  test("makes the username available to a different user", async () => {
    const t = setup();
    await setUsername(t, "user1", "alice");
    await t.mutation(api.public.deleteUsername, { userId: "user1" });
    expect(await setUsername(t, "user2", "alice")).toEqual({ success: true, previousUsername: null });
  });

  test("reports deleted: false when the user has no username", async () => {
    const t = setup();
    expect(await t.mutation(api.public.deleteUsername, { userId: "nobody" })).toEqual({ deleted: false });
  });

  test("deletes only the username of the given user", async () => {
    const t = setup();
    await setUsername(t, "user1", "alice");
    await setUsername(t, "user2", "bob");
    await t.mutation(api.public.deleteUsername, { userId: "user1" });
    expect(await getUsername(t, "user2")).toBe("bob");
  });
});
