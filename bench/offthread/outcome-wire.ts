// STUDY-194 §4.2: what an execution worker's outcome costs the MAIN thread to receive and decode, by encoding.
//   bun bench/offthread/outcome-wire.ts
// An outcome is what the committer and the query cache take: the result's JSON text, the read set as key intervals
// (`Interval[]`, keys as `Uint8Array`), and for a mutation its document and index writes (`DocWrite[]`,
// `LoggedIndexWrite[]`). Four encodings:
//   - clone:  the objects, posted as they are (structured clone);
//   - text:   one string, fields length-prefixed as the SQLite writer thread's wire (#878), keys one char per byte;
//   - buffer: one transferred ArrayBuffer, strings as UTF-8, keys as views into it;
//   - hybrid: a string for the text fields and one transferred ArrayBuffer for every key, posted together;
//   - text, docs passed on: as text, the document writes one opaque field the main thread does not decode (it would
//     hand it to the SQLite writer thread as it is).
// Three outcomes: a query of 20 documents (3.4 KiB result, 6 intervals), a one-document mutation (1 write, 5 index
// entries, 6 intervals), a 20-document mutation (20 writes, 100 index entries, 12 intervals).
// Measured: encode and decode in one thread (µs per outcome), then a Worker sending outcomes to the main thread with
// WINDOW in flight, which decodes each (µs of wall time per outcome, the main thread being the bottleneck; on Linux
// also the main thread's CPU per outcome, from /proc). Env: N (outcomes per measurement, 20 000), WINDOW (64).
export {};

const N = Number(process.env.N ?? 20_000);
const WINDOW = Number(process.env.WINDOW ?? 64);

type Interval = { index: string; lo: Uint8Array; hi: Uint8Array };
type DocWrite = { table: string; id: string; json: string | null; prevTs: bigint | null };
type IndexWrite = { index: string; key: Uint8Array; table: string | null; id: string | null; docId: string | null };
type Outcome = { result: string; reads: Interval[]; docs: DocWrite[]; idx: IndexWrite[]; counters: number[] };

// --- sample outcomes -------------------------------------------------------------------------------------------
const hex = (i: number, n = 32) => i.toString(16).padStart(n, "0");
const key = (i: number, len: number) => {
  const b = new Uint8Array(len);
  for (let j = 0; j < len; j++) b[j] = (i * 31 + j * 7) & 0xff;
  return b;
};
const doc = (i: number) =>
  JSON.stringify({
    _id: `k57${hex(i, 29)}`,
    _creationTime: 1761488000000 + i,
    tenantId: "t42",
    title: `item ${i} of tenant 42`,
    status: i % 3 ? "open" : "done",
    amount: 1234 + i,
    createdAt: 1761488000000 - i * 1000,
  });
function outcome(docs: number, writes: number, intervals: number): Outcome {
  const result = writes
    ? JSON.stringify({ ok: true, n: writes })
    : `[${Array.from({ length: docs }, (_, i) => doc(i)).join(",")}]`;
  const reads = Array.from({ length: intervals }, (_, i) => ({
    index: hex(100 + i),
    lo: key(i, 40),
    hi: key(i + 1, 41),
  }));
  const dw: DocWrite[] = [];
  const iw: IndexWrite[] = [];
  for (let i = 0; i < writes; i++) {
    const id = hex(5000 + i);
    dw.push({ table: hex(7), id, json: doc(i), prevTs: i % 2 ? 1761488000000000000n + BigInt(i) : null });
    for (let j = 0; j < 5; j++) {
      const removed = j % 2 === 1;
      iw.push({
        index: hex(200 + j),
        key: key(i * 5 + j, 48),
        table: removed ? null : hex(7),
        id: removed ? null : id,
        docId: removed ? null : `k57${hex(i, 29)}`,
      });
    }
  }
  return { result, reads, docs: dw, idx: iw, counters: [docs, 3400, writes, 300 * writes, 120] };
}
const SAMPLES: Record<string, Outcome> = {
  "query, 20 docs": outcome(20, 0, 6),
  "mutation, 1 write": outcome(0, 1, 6),
  "mutation, 20 writes": outcome(0, 20, 12),
};

// --- text: one string, `<length>:<chars>` fields, `_` for null, keys one char per byte ------------------------
const bytesText = (b: Uint8Array) => String.fromCharCode.apply(null, b as unknown as number[]);
function textBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
/** `passDocs`: the document writes as one opaque field, which the main thread hands on without decoding it. */
function encodeText(o: Outcome, withKeys = true, passDocs = false): string {
  const p: string[] = [];
  const str = (s: string) => p.push(`${s.length}:`, s);
  const opt = (s: string | null) => (s === null ? p.push("_") : str(s));
  const num = (n: number | bigint) => p.push(`${n}:`);
  str(o.result);
  num(o.counters.length);
  for (const c of o.counters) num(c);
  num(o.reads.length);
  for (const r of o.reads) {
    str(r.index);
    if (withKeys) {
      str(bytesText(r.lo));
      str(bytesText(r.hi));
    } else {
      num(r.lo.length);
      num(r.hi.length);
    }
  }
  if (passDocs) str(encodeText({ result: "", reads: [], docs: o.docs, idx: [], counters: [] }));
  else {
    num(o.docs.length);
    for (const d of o.docs) {
      str(d.table);
      str(d.id);
      opt(d.json);
      if (d.prevTs === null) p.push("_");
      else num(d.prevTs);
    }
  }
  num(o.idx.length);
  for (const e of o.idx) {
    str(e.index);
    if (withKeys) str(bytesText(e.key));
    else num(e.key.length);
    opt(e.table);
    opt(e.id);
    opt(e.docId);
  }
  return p.join("");
}
class TextReader {
  pos = 0;
  constructor(private s: string) {}
  private head() {
    const end = this.s.indexOf(":", this.pos);
    const h = this.s.slice(this.pos, end);
    this.pos = end + 1;
    return h;
  }
  str() {
    const n = Number(this.head());
    const v = this.s.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  isNull() {
    if (this.s.charCodeAt(this.pos) !== 95) return false;
    this.pos++;
    return true;
  }
  opt() {
    return this.isNull() ? null : this.str();
  }
  int() {
    return Number(this.head());
  }
  big() {
    return BigInt(this.head());
  }
}
/** `keys`: where the keys are when they are not in the text (hybrid): read in order. */
function decodeText(s: string, keys?: Uint8Array, passDocs = false): Outcome & { docsText?: string } {
  const r = new TextReader(s);
  let at = 0;
  const k = () => {
    if (!keys) return textBytes(r.str());
    const n = r.int();
    const v = keys.subarray(at, at + n);
    at += n;
    return v;
  };
  const result = r.str();
  const counters = Array.from({ length: r.int() }, () => r.int());
  const reads: Interval[] = [];
  for (let i = r.int(); i > 0; i--) reads.push({ index: r.str(), lo: k(), hi: k() });
  const docs: DocWrite[] = [];
  const docsText = passDocs ? r.str() : undefined;
  if (!passDocs)
    for (let i = r.int(); i > 0; i--)
      docs.push({ table: r.str(), id: r.str(), json: r.opt(), prevTs: r.isNull() ? null : r.big() });
  const idx: IndexWrite[] = [];
  for (let i = r.int(); i > 0; i--) idx.push({ index: r.str(), key: k(), table: r.opt(), id: r.opt(), docId: r.opt() });
  return { result, reads, docs, idx, counters, docsText };
}

// --- buffer: one ArrayBuffer; u32 counts and lengths, UTF-8 strings, keys as views ----------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();
function encodeBuffer(o: Outcome): ArrayBuffer {
  let buf = new Uint8Array(4096);
  let view = new DataView(buf.buffer);
  let pos = 0;
  const room = (n: number) => {
    if (pos + n <= buf.length) return;
    const next = new Uint8Array(Math.max(buf.length * 2, pos + n));
    next.set(buf);
    buf = next;
    view = new DataView(buf.buffer);
  };
  const u32 = (n: number) => {
    room(4);
    view.setUint32(pos, n, true);
    pos += 4;
  };
  const raw = (b: Uint8Array) => {
    u32(b.length);
    room(b.length);
    buf.set(b, pos);
    pos += b.length;
  };
  const str = (s: string) => {
    room(4 + s.length * 3);
    const { written } = enc.encodeInto(s, buf.subarray(pos + 4));
    view.setUint32(pos, written, true);
    pos += 4 + written;
  };
  const opt = (s: string | null) => (s === null ? u32(0xffffffff) : str(s));
  str(o.result);
  u32(o.counters.length);
  for (const c of o.counters) u32(c);
  u32(o.reads.length);
  for (const r of o.reads) {
    str(r.index);
    raw(r.lo);
    raw(r.hi);
  }
  u32(o.docs.length);
  for (const d of o.docs) {
    str(d.table);
    str(d.id);
    opt(d.json);
    opt(d.prevTs === null ? null : String(d.prevTs));
  }
  u32(o.idx.length);
  for (const e of o.idx) {
    str(e.index);
    raw(e.key);
    opt(e.table);
    opt(e.id);
    opt(e.docId);
  }
  return buf.buffer.slice(0, pos);
}
function decodeBuffer(ab: ArrayBuffer): Outcome {
  const buf = new Uint8Array(ab);
  const view = new DataView(ab);
  let pos = 0;
  const u32 = () => {
    const n = view.getUint32(pos, true);
    pos += 4;
    return n;
  };
  const raw = () => {
    const n = u32();
    const v = buf.subarray(pos, pos + n);
    pos += n;
    return v;
  };
  const str = () => dec.decode(raw());
  const opt = () => {
    if (view.getUint32(pos, true) === 0xffffffff) {
      pos += 4;
      return null;
    }
    return str();
  };
  const result = str();
  const counters = Array.from({ length: u32() }, () => u32());
  const reads: Interval[] = [];
  for (let i = u32(); i > 0; i--) reads.push({ index: str(), lo: raw(), hi: raw() });
  const docs: DocWrite[] = [];
  for (let i = u32(); i > 0; i--) {
    const table = str();
    const id = str();
    const json = opt();
    const prev = opt();
    docs.push({ table, id, json, prevTs: prev === null ? null : BigInt(prev) });
  }
  const idx: IndexWrite[] = [];
  for (let i = u32(); i > 0; i--) idx.push({ index: str(), key: raw(), table: opt(), id: opt(), docId: opt() });
  return { result, reads, docs, idx, counters };
}

// --- hybrid: the text without its keys, and the keys in one buffer -------------------------------------------
function encodeHybrid(o: Outcome): { t: string; b: ArrayBuffer } {
  let n = 0;
  for (const r of o.reads) n += r.lo.length + r.hi.length;
  for (const e of o.idx) n += e.key.length;
  const b = new Uint8Array(n);
  let at = 0;
  for (const r of o.reads) {
    b.set(r.lo, at);
    at += r.lo.length;
    b.set(r.hi, at);
    at += r.hi.length;
  }
  for (const e of o.idx) {
    b.set(e.key, at);
    at += e.key.length;
  }
  return { t: encodeText(o, false), b: b.buffer };
}
const decodeHybrid = (m: { t: string; b: ArrayBuffer }) => decodeText(m.t, new Uint8Array(m.b));

// --- in one thread -----------------------------------------------------------------------------------------------
type Format = {
  encode: (o: Outcome) => unknown;
  decode: (m: unknown) => Outcome;
};
// The worker (`workerSrc`) posts a fresh copy of a buffer per outcome, since a transferred buffer is gone.
const FORMATS: Record<string, Format> = {
  clone: { encode: (o) => o, decode: (m) => m as Outcome },
  text: { encode: (o) => encodeText(o), decode: (m) => decodeText(m as string) },
  // The documents' segment kept as text, to be handed on to the SQLite writer thread as it is.
  "text, docs passed on": {
    encode: (o) => encodeText(o, true, true),
    decode: (m) => decodeText(m as string, undefined, true),
  },
  buffer: { encode: encodeBuffer, decode: (m) => decodeBuffer(m as ArrayBuffer) },
  hybrid: { encode: encodeHybrid, decode: (m) => decodeHybrid(m as { t: string; b: ArrayBuffer }) },
};

function same(a: Outcome, decoded: Outcome & { docsText?: string }) {
  const { docsText, ...b } = decoded;
  if (docsText !== undefined) b.docs = decodeText(docsText).docs;
  const k = (x: Outcome) =>
    JSON.stringify(x, (_, v) => (v instanceof Uint8Array ? [...v] : typeof v === "bigint" ? String(v) : v));
  if (k(a) !== k(b)) throw new Error("a format did not round-trip");
}

function inThread(sample: string, fmt: string) {
  const o = SAMPLES[sample];
  const f = FORMATS[fmt];
  same(o, f.decode(f.encode(o)));
  const reps = 20_000;
  let t0 = performance.now();
  let e: unknown;
  for (let i = 0; i < reps; i++) e = f.encode(o);
  const encUs = ((performance.now() - t0) * 1000) / reps;
  t0 = performance.now();
  for (let i = 0; i < reps; i++) f.decode(e);
  const decUs = ((performance.now() - t0) * 1000) / reps;
  const size = typeof e === "string" ? e.length : e instanceof ArrayBuffer ? e.byteLength : "—";
  return { encUs, decUs, size };
}

// --- across threads ----------------------------------------------------------------------------------------------
const workerSrc = `
let payload = null, fmt = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m && m.setup) { payload = m.payload; fmt = m.fmt; return; }
  if (fmt === "buffer") { const c = payload.slice(0); postMessage(c, [c]); }
  else if (fmt === "hybrid") { const c = payload.b.slice(0); postMessage({ t: payload.t, b: c }, [c]); }
  else postMessage(payload);
};
`;
const url = URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" }));

function mainThreadCpuMs(): number | null {
  if (process.platform !== "linux") return null;
  const s = require("node:fs").readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8") as string;
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  return ((Number(f[11]) + Number(f[12])) * 1000) / 100;
}

async function acrossThreads(sample: string, fmt: string) {
  const f = FORMATS[fmt];
  const w = new Worker(url);
  w.postMessage({ setup: true, payload: f.encode(SAMPLES[sample]), fmt });
  const run = (n: number) =>
    new Promise<void>((resolve) => {
      let sent = 0;
      let got = 0;
      w.onmessage = (e) => {
        f.decode(e.data);
        if (++got === n) return resolve();
        if (sent < n) {
          sent++;
          w.postMessage(0);
        }
      };
      for (; sent < Math.min(WINDOW, n); sent++) w.postMessage(0);
    });
  await run(2000);
  const c0 = mainThreadCpuMs();
  const t0 = performance.now();
  await run(N);
  const wallUs = ((performance.now() - t0) * 1000) / N;
  const c1 = mainThreadCpuMs();
  w.terminate();
  return { wallUs, cpuUs: c0 === null || c1 === null ? null : ((c1 - c0) * 1000) / N };
}

console.log(`Bun ${Bun.version}, ${process.platform}/${process.arch}, N=${N}, WINDOW=${WINDOW}\n`);
console.log(
  "| outcome | encoding | size | encode, worker (µs) | decode, main (µs) | per outcome across threads, main (µs) | main CPU per outcome (µs, Linux) |",
);
console.log("|---|---|---:|---:|---:|---:|---:|");
for (const sample of Object.keys(SAMPLES))
  for (const fmt of Object.keys(FORMATS)) {
    const a = inThread(sample, fmt);
    const b = await acrossThreads(sample, fmt);
    console.log(
      `| ${sample} | ${fmt} | ${a.size} | ${fmt === "clone" ? "—" : a.encUs.toFixed(2)} | ${fmt === "clone" ? "—" : a.decUs.toFixed(2)} | ${b.wallUs.toFixed(2)} | ${b.cpuUs === null ? "—" : b.cpuUs.toFixed(2)} |`,
    );
  }
process.exit(0);
