// `defaultStorage` by runtime (STUDY-201 §3.4), upstream's `browser/storage.test.ts` ported: `localStorage` in a browser,
// memory silently on a server, memory with one warning where there is a `window` without `localStorage` (React Native).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { defaultStorage, InMemoryStorage, resetInMemoryFallbackWarning } from "../src/browser/storage.ts";

// The DOM preload's own `window`, put back after each test (some set another).
const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, "window");
const setWindow = (value: unknown) => {
  Object.defineProperty(globalThis, "window", { value, configurable: true, writable: true });
};

describe("defaultStorage", () => {
  beforeEach(() => resetInMemoryFallbackWarning());
  afterEach(() => {
    if (ORIGINAL_WINDOW === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", ORIGINAL_WINDOW);
  });

  test("uses localStorage in a browser", () => {
    const localStorage = new InMemoryStorage();
    setWindow({ localStorage });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(defaultStorage()).toBe(localStorage);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("falls back to memory silently on a server", () => {
    setWindow(undefined);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // In memory is right for one server render: every request would log otherwise.
      expect(defaultStorage()).toBeInstanceOf(InMemoryStorage);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("warns once when a runtime has `window` but no localStorage", () => {
    // React Native's shape: sessions would vanish on restart without a word.
    setWindow({ navigator: {} });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(defaultStorage()).toBeInstanceOf(InMemoryStorage);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/^\[bunvex-auth\] .*storage/);
      // A provider mounting again does not repeat it.
      defaultStorage();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
