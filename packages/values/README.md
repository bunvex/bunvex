# @bunvex/values

Validators (v.string(), v.id()…), table-tagged ids and value types shared by client and server.

- `v`: the validators (`v.string()`, `v.id("users")`, `v.object()`…) and `Infer<>`;
- `encodeId` / `decodeId`: Convex-format ids, a table number and a checksum;
- the value model: values, their JSON form, their total order and sort keys;
- `BunvexError`, the error that carries `data` to the client;
- `toExportJson` / `fromExportJson`: the snapshot export format.

What is built and what is next: [ARCHITECTURE.md](../../ARCHITECTURE.md).
