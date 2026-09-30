// The mock's file storage (UI-01 §14.3, STUDY-12 §9): blobs with Convex's metadata (storage id, base64
// SHA-256, size, content type, creation time) and a URL the browser can load. A few images, texts and
// binaries to start with. Pure state; MockDataSource wraps it in its latency and gates.
import { DataSourceError, type FileQuery, type Page, type StoredFile, type Value } from "../data-source.ts";
import type { Random } from "./random.ts";

export type FileHost = {
  rnd: Random;
  paginate: <T>(
    items: T[],
    key: (t: T) => Value[],
    q: { numItems: number; cursor: string | null },
    query: string,
  ) => Page<T>;
};

type Entry = { meta: Omit<StoredFile, "url">; blob: Blob; url?: string };

const COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2"];
const INITIALS = ["AL", "AT", "BL", "ED", "FA", "GH"];

function sampleFiles(rnd: Random): Blob[] {
  const avatars = INITIALS.map(
    (t, i) =>
      new Blob(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="${COLORS[i]}"/><text x="48" y="58" font-family="sans-serif" font-size="32" fill="#fff" text-anchor="middle">${t}</text></svg>`,
        ],
        { type: "image/svg+xml" },
      ),
  );
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => rnd.int(0, 255));
  return [
    ...avatars,
    new Blob(["Release notes\n\n- group commit\n- the query cache\n"], { type: "text/plain" }),
    new Blob([JSON.stringify({ tasks: 1000, exportedBy: "dashboard" }, null, 2)], { type: "application/json" }),
    new Blob(["name,email\nAda,ada@example.com\nAlan,alan@example.com\n"], { type: "text/csv" }),
    new Blob([new TextEncoder().encode("%PDF-1.7\n"), bytes(2048)], { type: "application/pdf" }),
    new Blob([bytes(4096)], { type: "application/octet-stream" }),
    new Blob([bytes(512)]), // no content type
  ];
}

async function sha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return btoa(String.fromCharCode(...digest));
}

export class MockFiles {
  private entries: Entry[] = [];
  private readonly watchers = new Set<() => void>();
  /** Hashing is asynchronous: every read waits for the sample files. */
  readonly ready: Promise<void>;

  constructor(
    private readonly host: FileHost,
    now: number,
    sample = true,
  ) {
    const blobs = sample ? sampleFiles(host.rnd) : [];
    const times = blobs.map(() => now - host.rnd.int(60, 30 * 86_400) * 1000).sort((a, b) => a - b);
    this.ready = Promise.all(blobs.map((b, i) => this.add(b, times[i]!, false))).then(() => {});
  }

  private async add(blob: Blob, creationTime: number, notify: boolean): Promise<string> {
    const id = this.host.rnd.id();
    const entry: Entry = {
      meta: { id, creationTime, sha256: await sha256(blob), size: blob.size, contentType: blob.type || null },
      blob,
    };
    this.entries.push(entry);
    this.entries.sort((a, b) => a.meta.creationTime - b.meta.creationTime || (a.meta.id < b.meta.id ? -1 : 1));
    if (notify) this.changed();
    return id;
  }

  private file(e: Entry): StoredFile {
    // an object URL where the platform has them (browsers, Bun), else a data URL is not worth it: none
    e.url ??= typeof URL.createObjectURL === "function" ? URL.createObjectURL(e.blob) : `mock:${e.meta.id}`;
    return { ...e.meta, url: e.url };
  }

  async list(q: FileQuery): Promise<Page<StoredFile>> {
    await this.ready;
    const desc = (q.order ?? "desc") === "desc";
    const rows = this.entries
      .filter(
        (e) =>
          (q.from === undefined || e.meta.creationTime >= q.from) &&
          (q.to === undefined || e.meta.creationTime <= q.to),
      )
      .map((e) => this.file(e));
    if (desc) rows.reverse();
    const sign = desc ? -1 : 1;
    return this.host.paginate(
      rows,
      (f) => [sign * f.creationTime, f.id],
      q,
      `files\u0000${q.order ?? "desc"}\u0000${q.from ?? ""}\u0000${q.to ?? ""}`,
    );
  }

  async count(): Promise<number> {
    await this.ready;
    return this.entries.length;
  }

  async get(id: string): Promise<StoredFile | null> {
    await this.ready;
    const e = this.entries.find((x) => x.meta.id === id);
    return e ? this.file(e) : null;
  }

  /** Not part of the contract: the stored blob, for tests. */
  async blob(id: string): Promise<Blob | null> {
    await this.ready;
    return this.entries.find((x) => x.meta.id === id)?.blob ?? null;
  }

  async upload(blob: Blob, now: number): Promise<string> {
    await this.ready;
    if (!(blob instanceof Blob)) throw new DataSourceError("invalid_request", "uploadFile takes a Blob or a File");
    return this.add(blob, now, true);
  }

  async delete(ids: string[]) {
    await this.ready;
    const gone = new Set(ids);
    const before = this.entries.length;
    for (const e of this.entries) if (gone.has(e.meta.id) && e.url?.startsWith("blob:")) URL.revokeObjectURL(e.url);
    this.entries = this.entries.filter((e) => !gone.has(e.meta.id));
    if (this.entries.length !== before) this.changed();
  }

  watch(onChange: () => void): () => void {
    this.watchers.add(onChange);
    return () => this.watchers.delete(onChange);
  }

  private changed() {
    if (this.watchers.size === 0) return;
    setTimeout(() => {
      for (const w of this.watchers) w();
    }, 0);
  }
}
