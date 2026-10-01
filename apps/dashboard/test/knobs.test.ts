import { describe, expect, test } from "bun:test";
import { takeDevKnobs } from "../src/knobs.ts";

function env(href: string, stored: Record<string, string> = {}) {
  const url = new URL(href);
  const location = { search: url.search, pathname: url.pathname, hash: url.hash };
  const replaced: string[] = [];
  const history = {
    state: { key: "k" },
    replaceState: (_: unknown, __: string, to?: string | URL | null) => void replaced.push(String(to)),
  };
  const storage = {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => {
      stored[k] = v;
    },
  };
  return { env: { location, history, storage }, replaced, stored };
}

describe("the dev host's mock knobs", () => {
  test("read from the query, then taken out of the address; the route's own search stays", () => {
    const { env: e, replaced } = env("http://localhost:5173/database/users?writes=0&panel=schema&latency=50");
    const knobs = takeDevKnobs(e);
    expect(knobs.get("writes")).toBe("0");
    expect(knobs.get("latency")).toBe("50");
    expect(knobs.has("panel")).toBe(false);
    expect(replaced).toEqual(["/database/users?panel=schema"]);
  });

  test("tables=0 is a knob too", () => {
    const { env: e, replaced } = env("http://localhost:5173/database?tables=0");
    expect(takeDevKnobs(e).get("tables")).toBe("0");
    expect(replaced).toEqual(["/database"]);
  });

  test("nodes is a knob too", () => {
    const { env: e, replaced } = env("http://localhost:5173/topology?nodes=4&node=node-b");
    expect(takeDevKnobs(e).get("nodes")).toBe("4");
    expect(replaced).toEqual(["/topology?node=node-b"]);
  });

  test("volume knobs (tasks, executions) are knobs too", () => {
    const { env: e, replaced } = env("http://localhost:5173/database/tasks?tasks=100000&executions=4000&panel=schema");
    const k = takeDevKnobs(e);
    expect([k.get("tasks"), k.get("executions")]).toEqual(["100000", "4000"]);
    expect(replaced).toEqual(["/database/tasks?panel=schema"]);
  });

  test("an address with only knobs keeps just its path", () => {
    const { env: e, replaced } = env("http://localhost:5173/logs?fail=0.5");
    expect(takeDevKnobs(e).get("fail")).toBe("0.5");
    expect(replaced).toEqual(["/logs"]);
  });

  test("the route's search alone is not touched", () => {
    const { env: e, replaced } = env("http://localhost:5173/database/users?panel=schema");
    expect(takeDevKnobs(e).size).toBe(0);
    expect(replaced).toEqual([]);
  });

  test("a reload without them keeps the tab's knobs", () => {
    const first = env("http://localhost:5173/?fail=0.2");
    takeDevKnobs(first.env);
    const { env: e, replaced } = env("http://localhost:5173/logs", first.stored);
    expect(takeDevKnobs(e).get("fail")).toBe("0.2");
    expect(replaced).toEqual([]);
  });

  test("without storage (a private window) they still apply once", () => {
    const { env: e } = env("http://localhost:5173/?writes=100");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(takeDevKnobs({ ...e, storage: broken }).get("writes")).toBe("100");
    expect(takeDevKnobs({ ...env("http://localhost:5173/").env, storage: broken }).size).toBe(0);
  });
});
