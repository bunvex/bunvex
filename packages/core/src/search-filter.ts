// What a search filter callback returns (`withSearchIndex(name, q => q.search(…).eq(…))`), as Convex's abstract
// `SearchFilter` class (npm-packages/convex/src/server/search_filter_builder.ts): a runtime class the search filter
// builder's objects extend, exported from `@bunvex/server`. Isomorphic: no runtime import, so the server's browser
// entry can export it too.

/** The result of a search filter builder: `instanceof SearchFilter` holds for each one. */
export abstract class SearchFilter {
  /** Types only (never set): makes the class nominal, so only the builder's objects are search filters. */
  declare private readonly _isSearchFilter: undefined;
}
