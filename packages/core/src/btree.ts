// `sorted-btree`'s class, however the module is loaded. It is CommonJS with `exports.default`: Bun's runtime
// gives that as the default import, but inside a bundle (`bun build --compile`, STUDY-39) a module that is
// loaded lazily imports it Node's way, where the default is the whole `module.exports`.

// The types name the class as the module's `default`: the class in a bundler's view and in Node's alike (an
// ES module's default import of CommonJS is the whole `module.exports` there), so the published declarations
// typecheck under either (STUDY-160).
import type * as SortedBTreeModule from "sorted-btree";
import SortedBTree from "sorted-btree";

type SortedBTreeClass = typeof SortedBTreeModule.default;
const loaded = SortedBTree as unknown as SortedBTreeClass | { default: SortedBTreeClass };
export const BTree = (typeof loaded === "function" ? loaded : loaded.default) as SortedBTreeClass;
export type BTree<K, V> = SortedBTreeModule.default<K, V>;
