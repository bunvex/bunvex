// `sorted-btree`'s class, however the module is loaded. It is CommonJS with `exports.default`: Bun's runtime
// gives that as the default import, but inside a bundle (`bun build --compile`, STUDY-39) a module that is
// loaded lazily imports it Node's way, where the default is the whole `module.exports`.
import SortedBTree from "sorted-btree";

const loaded = SortedBTree as unknown as typeof SortedBTree | { default: typeof SortedBTree };
export const BTree = (typeof loaded === "function" ? loaded : loaded.default) as typeof SortedBTree;
export type BTree<K, V> = SortedBTree<K, V>;
