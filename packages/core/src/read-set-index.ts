// An index over registered read-sets (STUDY-08 D9, DV-64): given the keys a commit wrote, find every owner
// (a cached query, a subscription, a sync execution) whose read-set contains one of them, without looking
// at the owners it does not touch. Convex does the same with one interval map per index in its
// SubscriptionManager (crates/database/src/subscription.rs; the map is crates/interval_map).
//
// Each index id has its own tree of intervals `[lo, hi)`: a treap ordered by `lo` whose nodes also keep the
// largest `hi` of their subtree. A point lookup skips every subtree whose largest `hi` is at or below the
// point and every right subtree whose `lo` is above it, so it costs about O((k + 1) log n) for k matches
// among n intervals, instead of the linear scan over owners × writes × intervals.

import type { Interval, LogEntry } from "./committer.ts";
import { compareKeys } from "./keyenc.ts";

type Node<K> = {
  index: number;
  lo: Uint8Array;
  hi: Uint8Array;
  owner: K;
  /** Breaks ties between equal `lo`s, so the tree order is total and a node can be found again. */
  seq: number;
  /** Heap order of the treap: a parent's priority is at least its children's. */
  prio: number;
  /** The largest `hi` in this node's subtree. */
  maxHi: Uint8Array;
  left: Node<K> | null;
  right: Node<K> | null;
};

/** A point written into an index: what a commit's log entry carries per write. */
export type IndexPoint = { index: number; key: Uint8Array };

export class ReadSetIndex<K> {
  private trees = new Map<number, Node<K>>();
  private owners = new Map<K, Node<K>[]>();
  private nextSeq = 0;
  private intervals = 0;
  /** xorshift32 for treap priorities: deterministic, and independent of the executions' seeded Math.random. */
  private rand = 0x9e3779b9;

  /** Owners registered (with or without intervals). */
  get size(): number {
    return this.owners.size;
  }

  /** Non-empty intervals registered, over all owners. */
  get intervalCount(): number {
    return this.intervals;
  }

  /** Indexes that have at least one interval registered. */
  get indexCount(): number {
    return this.trees.size;
  }

  has(owner: K): boolean {
    return this.owners.has(owner);
  }

  /** Register `owner`'s read-set, replacing what it had. Empty intervals (`lo >= hi`) contain nothing. */
  set(owner: K, reads: readonly Interval[]): void {
    this.delete(owner);
    const nodes: Node<K>[] = [];
    for (const r of reads) {
      if (compareKeys(r.lo, r.hi) >= 0) continue;
      const n: Node<K> = {
        index: r.index,
        lo: r.lo,
        hi: r.hi,
        owner,
        seq: this.nextSeq++,
        prio: this.random(),
        maxHi: r.hi,
        left: null,
        right: null,
      };
      this.trees.set(r.index, insert(this.trees.get(r.index) ?? null, n));
      nodes.push(n);
    }
    this.intervals += nodes.length;
    this.owners.set(owner, nodes);
  }

  /** Forget `owner`'s read-set. False when it had none registered. */
  delete(owner: K): boolean {
    const nodes = this.owners.get(owner);
    if (!nodes) return false;
    this.owners.delete(owner);
    for (const n of nodes) {
      const root = remove(this.trees.get(n.index) ?? null, n);
      if (root) this.trees.set(n.index, root);
      else this.trees.delete(n.index);
    }
    this.intervals -= nodes.length;
    return true;
  }

  /** Every owner whose read-set contains one of `writes` (`lo <= key < hi` on the same index), once each. */
  matching(writes: Iterable<IndexPoint>, into: Set<K> = new Set()): Set<K> {
    if (this.trees.size === 0) return into;
    for (const w of writes) {
      const root = this.trees.get(w.index);
      if (root) stab(root, w.key, into);
    }
    return into;
  }

  /** The same over all the writes of a group of commits. */
  matchingEntries(entries: readonly LogEntry[], into: Set<K> = new Set()): Set<K> {
    for (const e of entries) this.matching(e.writes, into);
    return into;
  }

  private random(): number {
    let x = this.rand;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rand = x >>> 0;
    return this.rand;
  }
}

/** Tree order: by `lo`, then by registration. */
function before<K>(a: Node<K>, b: Node<K>): boolean {
  const c = compareKeys(a.lo, b.lo);
  return c < 0 || (c === 0 && a.seq < b.seq);
}

function refresh<K>(n: Node<K>) {
  let m = n.hi;
  if (n.left && compareKeys(n.left.maxHi, m) > 0) m = n.left.maxHi;
  if (n.right && compareKeys(n.right.maxHi, m) > 0) m = n.right.maxHi;
  n.maxHi = m;
}

/** Split `t` into the nodes before `pivot` and the rest. */
function split<K>(t: Node<K> | null, pivot: Node<K>): [Node<K> | null, Node<K> | null] {
  if (!t) return [null, null];
  if (before(t, pivot)) {
    const [a, b] = split(t.right, pivot);
    t.right = a;
    refresh(t);
    return [t, b];
  }
  const [a, b] = split(t.left, pivot);
  t.left = b;
  refresh(t);
  return [a, t];
}

/** Join two trees where every node of `a` comes before every node of `b`. */
function join<K>(a: Node<K> | null, b: Node<K> | null): Node<K> | null {
  if (!a) return b;
  if (!b) return a;
  if (a.prio >= b.prio) {
    a.right = join(a.right, b);
    refresh(a);
    return a;
  }
  b.left = join(a, b.left);
  refresh(b);
  return b;
}

function insert<K>(t: Node<K> | null, n: Node<K>): Node<K> {
  if (!t) return n;
  if (n.prio > t.prio) {
    [n.left, n.right] = split(t, n);
    refresh(n);
    return n;
  }
  if (before(n, t)) t.left = insert(t.left, n);
  else t.right = insert(t.right, n);
  refresh(t);
  return t;
}

function remove<K>(t: Node<K> | null, n: Node<K>): Node<K> | null {
  if (!t) throw new Error("ReadSetIndex: interval not found");
  if (t === n) {
    const j = join(t.left, t.right);
    t.left = t.right = null;
    return j;
  }
  if (before(n, t)) t.left = remove(t.left, n);
  else t.right = remove(t.right, n);
  refresh(t);
  return t;
}

/** Add the owner of every interval under `t` that contains `key`. */
function stab<K>(t: Node<K> | null, key: Uint8Array, out: Set<K>) {
  while (t && compareKeys(key, t.maxHi) < 0) {
    stab(t.left, key, out);
    // Every node to the right starts at or after `t.lo`: none contains a key below it.
    if (compareKeys(t.lo, key) > 0) return;
    if (compareKeys(key, t.hi) < 0) out.add(t.owner);
    t = t.right;
  }
}
