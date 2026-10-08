# @bunvex/values

Validators (v.string(), v.id()…), table-tagged ids and value types shared by client and server.

- `v`: the validators (`v.string()`, `v.id("users")`, `v.object()`…) and `Infer<>` (STUDY-13, STUDY-100);
- `encodeId` / `decodeId`: Convex-format ids, a table number and a checksum (STUDY-01);
- the value model: values, their JSON form, their total order and sort keys (STUDY-18);
- `BunvexError`, the error that carries `data` to the client (STUDY-20);
- `toExportJson` / `fromExportJson`: the snapshot export format.

What is built and what is next: [ARCHITECTURE.md](../../ARCHITECTURE.md).
