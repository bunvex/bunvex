// What a search filter callback returns (`withSearchIndex(name, q => q.search(…).eq(…))`), as Convex's abstract
// `SearchFilter` class (npm-packages/convex/src/server/search_filter_builder.ts): a runtime class the search filter
// builder's objects extend, exported from `@bunvex/server`. Isomorphic: no runtime import, so the server's browser
// entry can export it too.

/** Types only (never set): the brand that makes `SearchFilter` nominal. */
declare const searchFilterBrand: unique symbol;

/** The result of a search filter builder: `instanceof SearchFilter` holds for each one. */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the merged interface holds a type-only field, never set (rule 7)
export abstract class SearchFilter {}
// Declared by merging, not as a `declare` field, so Babel (React Native's Metro) reads the source as written.
export interface SearchFilter {
  /** Types only (never set): makes the class nominal, so only the builder's objects are search filters. */
  readonly [searchFilterBrand]: undefined;
}
