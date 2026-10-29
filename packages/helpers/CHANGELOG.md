# @bunvex/helpers

## 0.1.0-alpha.0

### Minor Changes

- 61f52f6: `@bunvex/helpers/server/pagination`: convex-helpers' pagination (`getPage` with `PageRequest`'s defaults, `hasMore`
  and the raw `indexKeys`, `streamQuery`, `paginator`), on `server/stream` (STUDY-181 PR 4).
- 8b61178: `@bunvex/helpers/server/stream`: convex-helpers' streams (`stream`, `mergedStream`, `filterWith`, `map`, `flatMap`,
  `distinct`, `paginate` with `endCursor`, `maximumRowsRead` and `maximumBytesRead`, `streamIndexRange`,
  `getIndexFields`), with convex-helpers' cursors byte for byte (STUDY-181 PR 3).
- 12b597b: `@bunvex/helpers/server/triggers`: convex-helpers' triggers (`Triggers` with `register` and `wrapDB`,
  `writerWithTriggers`, `Change`, `Trigger`, and the deprecated `DatabaseWriterWithTriggers`), with their locks and queue
  kept per transaction instead of per module, so concurrent mutations do not wait on each other (DV-545, STUDY-181 PR 5).

### Patch Changes

- 0ea0a8d: Require Bun 1.4.4 or newer. CI, the Docker images and every package's `engines.bun` move off 1.4.2.

  A proxy that does not open an `https:` CONNECT fails with Convex's tunnel message: `proxy authorization required` for a 407, `unsuccessful` for any other status (before, the proxy's own 403 or 502 reached the app as a response). Bun 1.4.4 throws that refusal instead of answering it. An `https:` target that bunvex's address screen cannot reach still fails as it would without the screen. After an external package is installed, assigning `process.env` still writes the server's own environment.
