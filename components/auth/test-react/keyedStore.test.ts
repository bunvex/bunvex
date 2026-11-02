// The ambient sign-ins' value store (STUDY-201 §3.4), upstream's `browser/keyedStore.test.ts` ported.
import { describe, expect, mock, test } from "bun:test";
import { KeyedStore } from "../src/browser/keyedStore.ts";

describe("KeyedStore", () => {
  test("get returns undefined for a missing key", () => {
    expect(new KeyedStore().get("missing")).toBeUndefined();
  });

  test("set stores a value and get reads it back", () => {
    const store = new KeyedStore();
    store.set("greeting", "hello");
    expect(store.get<string>("greeting")).toBe("hello");
    store.set("greeting", "hi again");
    expect(store.get<string>("greeting")).toBe("hi again");
  });

  test("set notifies that key's subscribers", () => {
    const store = new KeyedStore();
    const listener = mock();
    store.subscribe("greeting", listener);
    store.set("greeting", "hello");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("set does not notify other keys' subscribers", () => {
    const store = new KeyedStore();
    const listener = mock();
    store.subscribe("other", listener);
    store.set("greeting", "hello");
    expect(listener).not.toHaveBeenCalled();
  });

  test("unsubscribing stops notifications", () => {
    const store = new KeyedStore();
    const listener = mock();
    const unsubscribe = store.subscribe("greeting", listener);
    store.set("greeting", "hello");
    unsubscribe();
    store.set("greeting", "hi again");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a scoped view reads and writes under its prefix", () => {
    const store = new KeyedStore();
    const scoped = store.forSignIn("oauth");
    scoped.set("actions", "registered");
    expect(store.get<string>("oauth/actions")).toBe("registered");
    expect(scoped.get<string>("actions")).toBe("registered");
    expect(store.get("actions")).toBeUndefined();
  });

  test("a scoped write notifies full-key subscribers", () => {
    const store = new KeyedStore();
    const listener = mock();
    store.subscribe("oauth/flowError", listener);
    store.forSignIn("oauth").set("flowError", "expired");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a scoped reader reads and subscribes under its prefix", () => {
    const store = new KeyedStore();
    const reader = store.forSignInReader("oauth");
    const listener = mock();
    reader.subscribe("actions", listener);
    store.forSignIn("oauth").set("actions", "registered");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reader.get<string>("actions")).toBe("registered");
    expect(reader.get("oauth/actions")).toBeUndefined();
  });
});
