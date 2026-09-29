# STUDY-01 — Document IDs (`_id`) and table numbers

- **Status:** decision pending (owner)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (2026-09-28)
- **Related:** [STUDY-03](STUDY-03-deterministic-execution.md) (IDs are generated inside a deterministic
  execution), [PERSIST-01](../specs/PERSIST-01-contract.md) (table and index ids are what persistence stores)

## 1. How Convex does it

### The string an app sees

`crates/value/src/id_v6.rs` encodes a `DeveloperDocumentId` in two steps:

```text
binary = [ VInt(table_number) ] [ internal id: 16 bytes ] [ footer: 2 bytes ]
footer = fletcher16(VInt(table_number) ++ internal id) XOR version      (version = 0)
string = base32(binary)
```

- **Base32:** Crockford's alphabet in lowercase, `0123456789abcdefghjkmnpqrstvwxyz`
  (`crates/value/src/base32.rs`). No `i`, `l`, `o` or `u`. Decoding is strict: uppercase and look-alikes
  are rejected.
- **Table number:** a VInt of 1 to 5 bytes. The ID string is therefore 31 to 37 characters. User tables
  start at 10 001 (`NUM_RESERVED_SYSTEM_TABLE_NUMBERS = 10000` in
  `crates/database/src/bootstrap_model/table.rs`), so their VInt is 2 bytes and **a typical ID is 32
  characters**.
- **Decode** (`DeveloperDocumentId::decode`):
  - The length is checked first, then the base32, then the table number (it must not be zero).
  - Then the footer: a mismatch gives `InvalidIdVersion`.
  - Trailing bytes are rejected.
  - So a typo or truncation is almost always caught locally, without a database read.

### The internal id (16 bytes)

`crates/database/src/transaction_id_generator.rs`:

- The first 14 bytes are random, from a ChaCha12 generator seeded once per transaction.
- The last 2 bytes are **the day number** (days since the Unix epoch, big-endian), pinned when the
  transaction starts.
- The time is at the **end**, not the front. So the ids are not time-ordered: two inserts in a row get
  unrelated ids.

### Table numbers are persistent

- Every table has a number, stored in the `_tables` system table. Once assigned, it never changes.
- The mapping number → name is what lets Convex resolve an id to its table:
  - `db.get(id)`, the legacy one-argument form;
  - `db.normalizeId(table, str)`;
  - the `v.id("users")` validator (`crates/common/src/schemas/validator.rs`, `Validator::Id`).
    It decodes the id, maps the number to a name and fails with `TableNamesDoNotMatch` when the id
    belongs to another table.
- Indexes are numbered and persisted in the same way (`_index`).

## 2. What an app can observe

1. `_id` is an opaque string of 31–37 lowercase base32 characters, 32 for a user table.
2. An id is tied to its table:
   - `v.id("users")` rejects an id of another table, and a malformed one;
   - `db.normalizeId("users", s)` returns the id or `null`;
   - `db.get(id)` works without a table name. It is deprecated in favour of `db.get("users", id)`, but it
     is still supported.
3. An id's order says nothing: nothing in the API sorts by `_id` except as the tiebreak inside an index.
   Default query order is `by_creation_time`.
4. An id is **not** a secret in Convex's model. Access control is the function's job. Still, with 112
   random bits, ids are unguessable in practice, and apps do use them as share links.
5. An id exported from Convex (snapshot export) is imported back with the same `_id`.

## 3. How bunvex does it today

- `_id` is `crypto.randomUUID()`: a v4 UUID, 36 characters with dashes.
- It says nothing about the table: `Tx.get(table, id)` needs the table.
- Table and index ids are small integers assigned **in the order the schema declares them**
  (`Schema.table`), and they are what persistence stores.
  - **Finding:** that is a latent data-corruption bug.
  - Reordering, inserting or removing a table in the schema silently remaps existing data to other
    tables.
  - Convex avoids this by persisting the numbers (`_tables`, `_index`). bunvex must do the same before
    the first release, whatever the id format.

## 4. Options

### A. Convex's format, with a UUIDv7 inside (recommended)

Keep Convex's string format exactly: base32, VInt table number, 16-byte internal id, fletcher16 footer.
Fill the 16 bytes with a **UUIDv7** built from the transaction's frozen time:
`Bun.randomUUIDv7("buffer", creationTime)`.

- **Same as Convex for apps:**
  - the same length and alphabet;
  - `v.id("table")`, `normalizeId` and `db.get(id)` can all resolve the table;
  - the same local typo detection.
- **Ids imported from Convex are valid bunvex ids.** They are just 16 other bytes behind the same format.
- **Time-ordered within a table.** The base32 alphabet is in ASCII order, so an id string sorts like its
  bytes: first the table number, then the v7 timestamp. The `by_id` index then grows at its right edge
  instead of at random positions. That helps the B-tree stores: SQLite, Postgres, and above all MySQL,
  whose InnoDB clusters on the primary key. It also brings `by_id` order close to `by_creation_time`
  order.
- **Randomness:** Bun's v7 layout is 48 bits of ms time, a 12-bit counter that is monotonic within the
  same ms, and **62 random bits** (checked on Bun 1.4.2). That is fewer than Convex's 112. Guessing an id
  still means hitting 62 random bits for a known millisecond, which is infeasible online. But the
  margin is smaller, and the id reveals its creation time to the millisecond. `_creationTime` already
  reveals that, since every document returns it.

### B. Plain UUIDv7 string as `_id`

`_id = Bun.randomUUIDv7()`: 36 characters with dashes.

- Simple and readable, and it has the same time ordering as A.
- **It diverges from Convex in what apps can observe:**
  - the id does not know its table, so `v.id("users")` can only check the format;
  - `db.normalizeId` cannot tell tables apart;
  - `db.get(id)` without a table needs a lookup across every table;
  - the length and alphabet differ, which breaks apps that validate ids with a regex or store them in
    fixed-size columns elsewhere;
  - an import from Convex must keep foreign-looking ids next to native ones.
- No checksum: a truncated id is only caught by a failed read.

### C. Convex's format and generator exactly

The same as A, but with 14 random bytes plus 2 day bytes, as Convex does.

- The most faithful option: 112 random bits.
- It loses the time ordering (random B-tree inserts), which buys nothing observable.

## 5. Divergences (for option A)

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | The internal 16 bytes are a UUIDv7 (time first, 62 random bits), not 14 random bytes + day | Index locality in B-tree stores; `by_id` ≈ creation order. Not observable except via the id's own bytes. | owner |
| D2 | Ids reveal their creation millisecond (Convex's reveal the day) | Consequence of D1; `_creationTime` is already public | owner |
| D3 | Table numbers of user tables: follow Convex (start at 10 001) | No divergence proposed; listed so it is a conscious choice | owner |

## 6. Tests (when implemented)

- **Round trip:** `decode(encode(table, bytes))` for random tables (1–5 byte VInts) and random bytes.
- **Rejections:** wrong length, a non-alphabet character, uppercase, a flipped character (the footer
  catches it), trailing bytes, table number 0.
- **Cross-check with Convex:** ids taken from a real Convex deployment decode to their table number, and
  encoding them again gives the same string. This checks format compatibility without reading Convex
  code into ours.
- **Order:** within one table, ids generated at increasing times sort in time order as strings.
- `v.id("t")` rejects an id of another table, and `normalizeId` returns `null` for one.
- **Persistence:** table and index numbers survive a restart with a reordered schema.

## 7. Open questions

1. Choose A, B or C. The recommendation is A.
2. Persisting table and index numbers (§3, finding) is needed in every option. It should be its own
   item, done before or together with the new ids.
