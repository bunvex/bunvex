// Analysis parity (STUDY-171 §7.4): a push analyzed in a child gives what `CodeVersion.load` gives in-process, for
// every example app and every load the server's pushed-code suites make (the corpus, written by
// scripts/sandbox-parity-corpus.ts). Each entry runs in both; the child's answer, decoded as the host decodes it, is
// compared with the in-process `CodeVersion`'s own fields, and a failure's class and words with the in-process one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { documentTypeError, indexReferenceError, schemaToJson, stagedDocumentError } from "@bunvex/core";
import {
  CodeVersion,
  type DefaultExportUse,
  isSchemaDefinition,
  type LoadOptions,
  type ModuleSource,
  NODE_FUNCTIONS,
  UnserializableAuthConfigError,
  vmExecutor,
} from "@bunvex/server/executor";
import { evaluatedValue, NOT_A_SCHEMA, SandboxProcess } from "../src/index.ts";
import { describeRoom } from "../src/version.ts";

type Options = { seed: number[]; timestamp: number; env: Record<string, string>; importTimeoutMs?: number };
type Entry =
  | { suite: string; kind: "load"; sources: ModuleSource[]; options: Options }
  | {
      suite: string;
      kind: "evaluate";
      source: ModuleSource;
      use: DefaultExportUse;
      options: Options & { failOnMissingEnv: boolean };
    };

const corpus = JSON.parse(
  new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(import.meta.dir, "fixtures/parity-corpus.json.gz")))),
) as Entry[];
const EXAMPLES = join(import.meta.dir, "../../../examples");

const loadOptions = (o: Options): LoadOptions => ({
  seed: Uint32Array.from(o.seed),
  timestamp: o.timestamp,
  env: o.env,
  ...(o.importTimeoutMs === undefined ? {} : { importTimeoutMs: o.importTimeoutMs }),
});

/** A load's outcome, as the push sees it: the analysis, or the error's class and words. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: { class: string; message: string } };
async function outcome<T>(f: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    return { ok: false, error: { class: (e as Error).constructor.name, message: callerFramesDropped(e as Error) } };
  }
}

/**
 * An error's message without this file's frames. An error the loader raises outside the app's code (an import that
 * runs out of time) keeps its caller's frames that are not the server's: this test's, in-process. The server's
 * own caller (the push) is a server file, whose frames are dropped, as the child's are.
 */
const callerFramesDropped = (e: Error) =>
  e.message
    .split("\n")
    .filter((l) => !(/^\s+at /.test(l) && l.includes(import.meta.path)))
    .join("\n");

/** What the host gets of a version: the in-process one's fields, as the child describes them. */
const inProcessView = (v: CodeVersion) => ({
  analysis: v.analysis,
  moduleHashes: v.moduleHashes,
  moduleLoads: v.moduleLoads,
  functions: new Map(
    [...v.functions].map(([k, f]) => [
      k,
      {
        kind: f.kind,
        visibility: f.visibility,
        node: NODE_FUNCTIONS.has(f),
        // The validators the stand-ins check with (STUDY-171 §8): each one's JSON, or none.
        args: f.args ? JSON.stringify(f.args.json) : null,
        returns: f.returns ? JSON.stringify(f.returns.json) : null,
      },
    ]),
  ),
  rooms: new Map([...v.rooms].map(([k, r]) => [k, describeRoom(r)])),
});

/** A schema as the push checks it: its export and the checks run on it (push.ts `checkIndexReferences`). */
function schemaView(value: unknown) {
  if (value === undefined || value === null) return { missing: true };
  if (value === NOT_A_SCHEMA || !isSchemaDefinition(value)) return { notSchema: true };
  let json: unknown;
  try {
    json = schemaToJson(value);
  } catch {
    // The push refuses it as it refuses one that is not a schema.
    return { notSchema: true };
  }
  return {
    json,
    documentTypeError: documentTypeError(value),
    stagedDocumentError: stagedDocumentError(value),
    indexReferenceError: indexReferenceError(value),
  };
}
/**
 * An auth config as the push reads it (push.ts `evaluateAuthConfig`): as its JSON, which Convex's isolate takes with
 * `v8::json::stringify` (crates/isolate/src/environment/auth_config.rs:286). In-process the push has the live value
 * and serializes it itself, refusing what `JSON.stringify` refuses (a bigint, a cycle) with
 * `UnserializableAuthConfigError`, the error the child's answer decodes to.
 */
function authView(value: unknown) {
  if (value === undefined) return { undefined: true };
  try {
    return { json: JSON.stringify(value) };
  } catch {
    throw new UnserializableAuthConfigError();
  }
}

let child: SandboxProcess;
beforeAll(async () => {
  child = await SandboxProcess.start();
});
afterAll(async () => {
  await child.close();
});

describe("the corpus", () => {
  test("covers every example app", () => {
    const examples = readdirSync(EXAMPLES)
      .filter((n) => !n.startsWith("_") && existsSync(join(EXAMPLES, n, "bunvex")))
      .map((n) => `examples/${n}`);
    const covered = new Set(corpus.map((e) => e.suite));
    expect(examples.filter((e) => !covered.has(e))).toEqual([]);
    expect(examples.length).toBeGreaterThan(20);
  });

  test("covers the server's pushed-code suites, successes and failures", () => {
    const fromSuites = corpus.filter((e) => !e.suite.startsWith("examples/"));
    expect(fromSuites.length).toBeGreaterThan(300);
    expect(corpus.some((e) => e.kind === "evaluate" && e.use === "schema")).toBe(true);
    expect(corpus.some((e) => e.kind === "evaluate" && e.use === "authConfig")).toBe(true);
  });
});

describe("a child analyzes as CodeVersion.load", () => {
  test.each(corpus.map((e, i) => [`${i} ${e.suite} ${e.kind}`, e] as const))(
    "%s",
    async (_, e) => {
      if (e.kind === "load") {
        const opts = loadOptions(e.options);
        const [here, there] = [
          await outcome(async () => inProcessView(await CodeVersion.load(e.sources, opts))),
          await outcome(async () => {
            const { loadMs: _, versionId: __, held: ___, ...version } = await child.load(e.sources, opts);
            return version;
          }),
        ];
        expect(there).toEqual(here);
        return;
      }
      const opts = { ...loadOptions(e.options), env: e.options.env, failOnMissingEnv: e.options.failOnMissingEnv };
      const view = e.use === "schema" ? schemaView : authView;
      const [here, there] = [
        await outcome(async () => view(await vmExecutor.evaluateDefault(e.source, opts, e.use))),
        await outcome(async () => view(evaluatedValue(await child.evaluate(e.source, opts, e.use)))),
      ];
      expect(there).toEqual(here);
    },
    30_000,
  );

  test("the child is still the one it started as (nothing crashed it)", () => {
    expect(child.failure).toBeNull();
  });
});
