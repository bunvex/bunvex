// Code versions across to the execution workers (STUDY-194 §4.8, 2b step iii). A worker holds the same registry the
// main thread resolves a call against, loaded from the same sources with the same loader and options, one per code
// epoch (`Functions.codeEpoch`, 0c). The main thread sends what a worker lacks before the first call that names an
// epoch, in the order a worker's messages run:
//
//   `v<id>:<json>`      a loaded version: its sources and load options (`VersionLoad`), loaded once per worker
//   `k<epoch>:<json>`   a code epoch: the app's version and each mounted component's, by id, with its runtime
//   `f<epoch>`          forget an epoch: no call will name it again; a version goes with the last epoch holding it
//
// The ids are the main thread's (`CodeShipper`). A component's code is loaded beside the app's version under the
// `process` sandbox only; a worker loads with `vm`, which loads every version alike, so `beside` does not cross.
// Registries with functions given as maps (`register`, embedded servers) have no sources: their calls stay
// in-thread (§10.4).
import type { LoadedCode, LoadOptions, ModuleSource } from "./code-version.ts";
import { loadCode, loadInputsOf, vmExecutor } from "./function-executor.ts";
import type { CodeSources, ComponentRuntime, Functions } from "./functions.ts";

/** A version as a worker loads it: what `loadCode` made it from. */
export type VersionLoad = {
  sources: ModuleSource[];
  seed: number[];
  timestamp: number;
  env: Record<string, string>;
  importTimeoutMs?: number;
  nodeModules?: string;
};

/** A code epoch: the app's version (none before a push) and each mounted component's, by version id. */
export type CodeEpoch = {
  app: number | null;
  components: { id: string; path: string; env: [string, unknown][]; httpPrefix: string | null; version: number }[];
};

/** What a worker holds, as the main thread counts it: the epochs sent and not forgotten, and their versions. */
export type CodeHeld = { epochs: Map<number, number[]>; versions: Set<number> };

export const newCodeHeld = (): CodeHeld => ({ epochs: new Map(), versions: new Set() });

/** The main thread's side: numbers the versions, and says what a worker lacks for an epoch. */
export class CodeShipper {
  private ids = new WeakMap<LoadedCode, number>();
  private next = 1;

  private idOf(v: LoadedCode): number {
    let id = this.ids.get(v);
    if (id === undefined) {
      id = this.next++;
      this.ids.set(v, id);
    }
    return id;
  }

  /**
   * The messages a worker holding `held` needs before a call at `epoch`, whose registry came from `sources`, and
   * `held` updated as if they were sent; null when a version was not loaded by `loadCode` (it cannot be sent).
   */
  prepare(epoch: number, sources: CodeSources | null, held: CodeHeld): string[] | null {
    if (held.epochs.has(epoch)) return [];
    if (!sources) return null;
    const versions = [...(sources.app ? [sources.app] : []), ...sources.components.map((c) => c.code)];
    const out: string[] = [];
    const fresh: number[] = [];
    for (const v of versions) {
      const id = this.idOf(v);
      if (held.versions.has(id) || fresh.includes(id)) continue;
      const inputs = loadInputsOf(v);
      if (!inputs) return null;
      out.push(`v${id}:${JSON.stringify(versionLoad(inputs.sources, inputs.opts))}`);
      fresh.push(id);
    }
    const e: CodeEpoch = {
      app: sources.app ? this.idOf(sources.app) : null,
      components: sources.components.map(({ runtime, code }) => ({
        id: runtime.id,
        path: runtime.path,
        env: [...runtime.env],
        httpPrefix: runtime.httpPrefix,
        version: this.idOf(code),
      })),
    };
    out.push(`k${epoch}:${JSON.stringify(e)}`);
    for (const id of fresh) held.versions.add(id);
    held.epochs.set(
      epoch,
      versions.map((v) => this.idOf(v)),
    );
    return out;
  }

  /** The message that makes a worker holding `held` forget `epoch`, and `held` updated; null if it does not hold it. */
  forget(epoch: number, held: CodeHeld): string | null {
    const ids = held.epochs.get(epoch);
    if (!ids) return null;
    held.epochs.delete(epoch);
    const still = new Set([...held.epochs.values()].flat());
    for (const id of ids) if (!still.has(id)) held.versions.delete(id);
    return `f${epoch}`;
  }
}

/** The options a worker loads with: the main thread's, without what cannot cross (a callback). */
function versionLoad(sources: ModuleSource[], opts: LoadOptions): VersionLoad {
  return {
    sources,
    seed: [...opts.seed],
    timestamp: opts.timestamp,
    env: { ...(opts.env ?? {}) },
    ...(opts.importTimeoutMs === undefined ? {} : { importTimeoutMs: opts.importTimeoutMs }),
    ...(opts.nodeModules === undefined ? {} : { nodeModules: opts.nodeModules }),
  };
}

/** A worker's side: the versions and epochs the main thread sent, each epoch's registry built once. */
export class WorkerCode {
  private versions = new Map<number, Promise<LoadedCode>>();
  private epochs = new Map<number, { versions: number[]; functions: Promise<Functions> }>();

  /** `make` gives an empty registry, which an epoch's code is installed in. */
  constructor(private make: () => Functions) {}

  /** Handles a code message (`v`, `k`, `f`); false for any other. */
  hear(text: string): boolean {
    const head = text[0];
    if (head === "v") {
      const colon = text.indexOf(":");
      const load = JSON.parse(text.slice(colon + 1)) as VersionLoad;
      const p = loadCode(
        load.sources,
        {
          seed: Uint32Array.from(load.seed),
          timestamp: load.timestamp,
          env: load.env,
          ...(load.importTimeoutMs === undefined ? {} : { importTimeoutMs: load.importTimeoutMs }),
          ...(load.nodeModules === undefined ? {} : { nodeModules: load.nodeModules }),
        },
        vmExecutor,
      );
      // A failure is the calls' (`at`), not an unhandled rejection here.
      p.catch(() => {});
      this.versions.set(Number(text.slice(1, colon)), p);
      return true;
    }
    if (head === "k") {
      const colon = text.indexOf(":");
      const epoch = Number(text.slice(1, colon));
      const e = JSON.parse(text.slice(colon + 1)) as CodeEpoch;
      const ids = [...(e.app === null ? [] : [e.app]), ...e.components.map((c) => c.version)];
      const loaded = ids.map((id) => {
        const v = this.versions.get(id);
        if (!v) throw new Error(`code epoch ${epoch} names version ${id}, which was not sent`);
        return v;
      });
      const functions = Promise.all(loaded).then((versions) => {
        const f = this.make();
        f.swap(() => {
          let i = 0;
          if (e.app !== null) f.installVersion(versions[i++]!);
          for (const c of e.components) {
            const runtime: ComponentRuntime = {
              id: c.id,
              path: c.path,
              env: new Map(c.env as [string, never][]),
              httpPrefix: c.httpPrefix,
            };
            f.installComponentVersion(runtime, versions[i++]!);
          }
        });
        return f;
      });
      functions.catch(() => {});
      this.epochs.set(epoch, { versions: ids, functions });
      return true;
    }
    if (head === "f") {
      const epoch = Number(text.slice(1));
      this.epochs.delete(epoch);
      const still = new Set([...this.epochs.values()].flatMap((e) => e.versions));
      for (const id of [...this.versions.keys()]) if (!still.has(id)) this.versions.delete(id);
      return true;
    }
    return false;
  }

  /** The registry of `epoch`, once its versions are loaded. */
  at(epoch: number): Promise<Functions> {
    const e = this.epochs.get(epoch);
    if (!e) return Promise.reject(new Error(`code epoch ${epoch} was not sent, or was forgotten`));
    return e.functions;
  }

  /** How many versions and epochs it holds. */
  get held() {
    return { versions: this.versions.size, epochs: this.epochs.size };
  }
}
