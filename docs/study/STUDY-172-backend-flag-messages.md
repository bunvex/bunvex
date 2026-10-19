# STUDY-172 — The backend's command-line messages, as clap writes them

- **Status:** implemented (this PR; the owner approved matching Convex, 2026-10-19)
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend; clap_builder 4.5.31 (Convex's
  `Cargo.lock` at that commit), read for its rules, not copied
- **Oracle:** Convex's binary `precompiled-2026-10-07-d8bdde0` (aarch64-apple-darwin, sha256 `4958145b…450d9b`),
  the one `packages/differential` runs
- **Related:** STUDY-40 L1 (the executable and its flags), STUDY-170 (DV-525, `INSTANCE_SECRET`), STUDY-171
  (`--function-sandbox`), DV-197 (the renamed flags)

`bunvex-local-backend` said it checked its flags "as Convex's clap definitions check them", but it wrote some
messages by hand. Given a value-taking flag without a value it named the value with a hyphen
(`--function-sandbox <FUNCTION-SANDBOX>`, `--deny-addresses <DENY-ADDRESSES>`), where clap writes
`<FUNCTION_SANDBOX>`. Running Convex's binary with each mistake showed more differences in the same messages:
the help printed after every error, `[possible values: …]`, the tips, the usage lines, and the port and
interface checks.

## 1. How Convex does it

`crates/local_backend/src/config.rs` derives its parser with clap (`#[derive(Parser)]`, L26–28). Nothing in it
sets `value_name`, so every value is named after its field: `site_proxy_port` → `<SITE_PROXY_PORT>`
(clap_derive uppercases the field's name, and a field's name has underscores). The fields that shape the
messages:

- `db_spec`, the positional, with a default (L30); `db` (`-d`, a `value_enum`, L34); `interface` (`-i`, an
  `Ipv4Addr`, L38); `port` (`-p`, `u16`, L42); `site_proxy_port` (`u16`, L46);
- `convex_origin` / `convex_site`, each `requires` the other (L57, L71); `instance_name` / `instance_secret`,
  each `requires` the other (L82, L86); `convex_http_proxy` (a `Url`, L78);
- `local_storage` and `s3_storage` in the group `storage`, `multiple(false)` (L27, L107, L111);
- the subcommand `keygen admin-key`, whose `instance_name` and `instance_secret` are required (L148–176).

clap's derive also puts every field into one group named after the struct; that group is what the "smart"
usage lines show as `<DB_SPEC|--db <DB>|…>` (below).

What is refused after the parse, in `main.rs` and `lib.rs`, ends `main` with `Error: <message>` and exit 1
(`MainError`): `secret()` (config.rs L244–251: "--instance-secret is required. Generate one with `openssl rand
-hex 32`"), `DeploymentSecret::try_from` (`crates/keybroker/src/secret.rs` L17–24: "Couldn't hexdecode key",
"Hex-decoded key was N bytes, not 32"), `convex_origin_url` / `convex_site_url` (config.rs L201–231:
"Origin url should start with https:// or http:// but got '…'", "Site url …"; an empty one is allowed).

### 1.1 clap's rules (clap_builder 4.5.31)

- **The error's shape** (`error/format.rs`, rich formatter): `error: <message>`; for a list of values,
  `  [possible values: a, b]`; a blank line and `  tip: …`; a blank line and a `Usage:` line, for some errors; a
  blank line and `For more information, try '--help'.`. Exit 2.
- **Values** (`parser.rs`): an option takes the next word unless it looks like a flag (`-` alone is a value), or
  an attached one (`--port=1`, `-p1`, `-p=1`). A value given as the next word waits until the word after it is
  read; when that word is an unknown argument, the waiting value's own error is dropped (`let _ =
  self.resolve_pending(…)`). `--` ends the options.
- **Messages:**
  - a value missing: `a value is required for '--port <PORT>' but none was supplied`, with the possible values for
    a `value_enum`; for a `value_enum` an empty value (`--db=`) is a missing one;
  - an invalid value: `invalid value 'x' for '--port <PORT>': <the parser's reason>`, or for a `value_enum`
    `invalid value 'x' for '--db <DB>'` with the possible values and `tip: a similar value exists: '…'`;
  - an unknown argument: `unexpected argument '--x' found`, with `tip: a similar argument exists: '--…'`, else (when
    the command has a positional) `tip: to pass '--x' as a value, use '-- --x'`;
  - a flag given a value: `unexpected value 'x' for '--s3-storage' found; no more were expected`;
  - twice: `the argument '--port <PORT>' cannot be used multiple times`;
  - a second positional: `unexpected argument 'b' found`, or `unrecognized subcommand 'b'` with a tip when a
    subcommand is similar (always for a command without positionals, as `keygen`);
  - after the parse, conflicts first, then requirements: `the argument '--s3-storage' cannot be used with
    '--local-storage <LOCAL_STORAGE>'`; `the following required arguments were not provided:` with each one.
- **Rust's parsers**, the reasons: a `u16` is parsed as an `i64`, then ranged: "cannot parse integer from empty
  string", "invalid digit found in string" (`1e3`, `0x10`, `-`), "number too large to fit in target type",
  "70000 is not in 0..=65535" (`+5` is 5). An `Ipv4Addr` is four decimal octets without leading zeros, else
  "invalid IPv4 address syntax" (`localhost`, `::`, `01.2.3.4`).
- **Suggestions** (`suggestions.rs`): strsim's Jaro similarity over 0.7, the most similar, the later one on a tie;
  candidates are the command's long flags (`--help`, `--version` included), its values, its subcommands.
- **Usage lines** (`output/usage.rs`): none for a missing or invalid value; the help's
  (`Usage: convex-local-backend [OPTIONS] [DB_SPEC] [COMMAND]`) for an unknown short flag, a repeated one, a
  second positional; otherwise built from the arguments matched so far ("smart usage"): the required arguments
  (with what each `requires`, unrolled), then the matched ones, then the positional (`<DB_SPEC>` given,
  `[DB_SPEC]` not). A matched group is shown as `<a|b|…>` instead of its members; because the derive's group
  holds every field, an unknown long flag after any matched argument (or with a suggestion, which counts as
  matched) prints `Usage: convex-local-backend <DB_SPEC|--db <DB>|…|--local-log-sink <LOCAL_LOG_SINK>>`, hidden
  fields included, plus `<--local-storage <LOCAL_STORAGE>|--s3-storage>` when a storage flag is involved.

### 1.2 Captured from the oracle

Run in a scratch directory with each mistake, stderr and exit code kept (the full capture, about 130 cases, is in
the PR's scratch notes; every case is re-run by `differential/test/backend-flags.test.ts`). The value-missing
ones, exit 2, each followed by a blank line and "For more information, try '--help'.":

```
error: a value is required for '--db <DB>' but none was supplied
  [possible values: sqlite, mysql-v5, mysql-v5-multitenant, mysql-v6-multitenant, postgres-v5]
error: a value is required for '--interface <INTERFACE>' but none was supplied        (also -i)
error: a value is required for '--port <PORT>' but none was supplied                  (also -p, --port --)
error: a value is required for '--site-proxy-port <SITE_PROXY_PORT>' but none was supplied
error: a value is required for '--convex-origin <CONVEX_ORIGIN>' but none was supplied
error: a value is required for '--convex-site <CONVEX_SITE>' but none was supplied
error: a value is required for '--convex-http-proxy <CONVEX_HTTP_PROXY>' but none was supplied
error: a value is required for '--instance-name <INSTANCE_NAME>' but none was supplied
error: a value is required for '--instance-secret <INSTANCE_SECRET>' but none was supplied
error: a value is required for '--local-storage <LOCAL_STORAGE>' but none was supplied
error: a value is required for '--local-log-sink <LOCAL_LOG_SINK>' but none was supplied
error: a value is required for '--control-plane-url <CONTROL_PLANE_URL>' but none was supplied
```

Some of the others:

```
$ convex-local-backend --bogus                                  # exit 2
error: unexpected argument '--bogus' found

  tip: to pass '--bogus' as a value, use '-- --bogus'

Usage: convex-local-backend [OPTIONS] [DB_SPEC] [COMMAND]

For more information, try '--help'.

$ convex-local-backend --db sqlit                               # exit 2
error: invalid value 'sqlit' for '--db <DB>'
  [possible values: sqlite, mysql-v5, mysql-v5-multitenant, mysql-v6-multitenant, postgres-v5]

  tip: a similar value exists: 'sqlite'

For more information, try '--help'.

$ convex-local-backend --port 70000                             # exit 2
error: invalid value '70000' for '--port <PORT>': 70000 is not in 0..=65535

$ convex-local-backend --interface localhost                    # exit 2
error: invalid value 'localhost' for '--interface <INTERFACE>': invalid IPv4 address syntax

$ convex-local-backend --instance-name x                        # exit 2
error: the following required arguments were not provided:
  --instance-secret <INSTANCE_SECRET>

Usage: convex-local-backend --instance-name <INSTANCE_NAME> --instance-secret <INSTANCE_SECRET> [DB_SPEC]

$ convex-local-backend                                          # exit 1
Error: --instance-secret is required. Generate one with `openssl rand -hex 32`

$ convex-local-backend --instance-name x --instance-secret zz   # exit 1
Error: Couldn't hexdecode key
```

## 2. What an app can observe

Nothing: these are the executable's messages to whoever starts it (an operator, a script, `bunvex dev`'s log).
`bunvex dev` reads only the exit code of `keygen admin-key` and the `[env: INSTANCE_SECRET]` in `--help`
(STUDY-170), both kept.

## 3. How bunvex does it

`packages/server/src/command-line.ts`: a small parser that follows the rules of §1.1 for a command described as
data (its flags with their values, `requires`, groups, required ones; its positional; its subcommands), and
writes clap's messages. `local-backend.ts` describes `bunvex-local-backend`, `keygen` and `keygen admin-key`
with it, in Convex's field order; bunvex's own flags (`--deny-addresses`, `--function-sandbox`) are described as
clap fields would be, so their value names are `<DENY_ADDRESSES>` and `<FUNCTION_SANDBOX>`.

- Every error clap writes is written the same way: value names, possible values, the tips (Jaro similarity, as
  strsim's), the usage lines (the help's, or the smart one with the derive's group), the trailer. The help is no
  longer printed after an error.
- `--port` / `--site-proxy-port` are checked as Rust's `u16` (`+5` is accepted, `0x10`, `1e3` and an empty value
  are not: an empty `--port=` used to mean port 0); `--interface` as an `Ipv4Addr` (it used to take any string).
- Short options take attached values (`-p4000`, `-p=4000`), `--` ends the options, a repeated option is refused,
  `--help` / `--version` act where they come (a mistake before them wins), `help` and `keygen help` print the
  helps, and bare `keygen` prints its help as an error (exit 2).
- What Convex refuses after the parse is refused after the parse, as `Error: <message>` with exit 1: the secret
  (now "Couldn't hexdecode key", Convex's words, for a secret that is not hex), the origins ("Site url …" for
  `--site-origin`), and bunvex's own "--db postgres needs the database's URL". `localBackendFlagsError` holds
  them; `startLocalBackend` refuses them before opening the store. A start failure is `Error:` too, as Convex's.
- `--help` keeps bunvex's descriptions; its usage line, commands and value names are clap's. `keygen admin-key
  --help` is clap's with `[env: INSTANCE_SECRET]` on the secret (DV-525).

The parser runs once per start; there is no hot path to measure.

## 4. Divergences

None new. What still differs is decided elsewhere and follows from it:

- DV-197: bunvex's flag names and `--db` values; so the suggestions differ where the names do (`--site` suggests
  `--site-origin` on bunvex, `--site-proxy-port` on Convex), and the derive's group lists bunvex's flags.
- STUDY-40 / DV-197: `--instance-secret` alone is accepted (with the default instance name), where Convex's
  requires `--instance-name`. Run through clap's rules, that relation puts `--instance-secret` before
  `--instance-name` in the usage line of a missing secret.
- DV-525: the secret may come from `INSTANCE_SECRET`, as clap's `env =` would take it.
- Found, not changed in that PR (§6 Q1): Convex's secret check takes a `0x` / `0X` prefix (`const_hex::decode`;
  the oracle accepts `0x<64 hex>`). Matched in a follow-up (§7).
- Logging: Convex's `keygen` logs a failed key as two `ERROR` lines before `Error: …`, and the backend logs
  `INFO` lines on stdout before its runtime errors; bunvex prints the `Error:` line only.

| # | Divergence | Why | Decision |
|---|---|---|---|

## 5. Tests

- `differential/test/backend-flags.test.ts` (local, with the oracle): 106 command lines run on Convex's binary
  and on bunvex's program, stderr and exit code compared after reading Convex's text in bunvex's names (DV-197's
  flags, the `--db` values, the derive's group); a value missing for every flag (at the end, before a flag,
  before `--`, empty), invalid values (enum, port, IPv4, URL), unknown arguments and suggestions, `--`, repeated
  flags, conflicts and requirements with their usage lines, the runtime errors, and `keygen`'s; then the helps
  of `keygen` and `keygen admin-key` and the exit codes of `--help`, `help`, `-V`.
- `server/test/local-backend.test.ts`: the same messages asserted exactly without the oracle (from §1.2), each
  flag's value name, bunvex's own flags and the cases that differ by decision (§4); the `Error:` / exit 1 split.
  `function-executor.test.ts` and `http-proxy.test.ts`: `--function-sandbox`'s and `--http-proxy`'s messages.
- **Sabotage** (each restored, `git diff` clean after): value names with hyphens again (unit 10 fail, oracle
  42); no `[possible values]` line (6, 8); no trailer (9, 99); an empty port accepted (1, 1); any interface
  accepted (1, 6); a stricter suggestion threshold (1, 6); `error:` for a runtime refusal (5, 4); no derive
  group in the smart usage (3, 15); a flag-like word taken as a value (2, 5).

## 6. Open questions

- **Q1 (resolved, §7; owner, 2026-10-19: match Convex):** a `0x`-prefixed instance secret. Convex's `DeploymentSecret::try_from`
  decodes with `const_hex::decode`, which drops a leading `0x` or `0X`: the oracle issues an admin key for
  `--instance-secret 0x<64 hex>` (and refuses `0x0x…`). bunvex refuses it. Matching it means reading the prefix
  in `instanceSecretError` and in core's `instanceSecretBytes` (and the engine's other uses of the secret's
  text), so it is a change of its own.

## 7. Follow-up: a `0x`-prefixed instance secret (Q1)

The owner approved matching Convex on 2026-10-19. Convex source read at `d8bdde0` and again at `72ce13c` (the
paths below are the same at both); oracles `precompiled-2026-10-07-d8bdde0` (sha256 `4958145b…d4450d9b`) and
`precompiled-2026-10-10-72ce13c` (sha256 `ddcb9772…9bd20db6`, the one `packages/differential` pins now). The
two binaries answered every case below the same way.

### 7.1 How Convex reads the secret

- `crates/keybroker/src/secret.rs` L17–25: `Secret::try_from(&str)` is `const_hex::decode`, then exactly 32
  bytes ("Couldn't hexdecode key", "Hex-decoded key was N bytes, not 32"). The `Secret` keeps the 32 bytes
  only; its `Display` (L52–54) writes them back as lowercase hex without a prefix. The backend's start
  (`local_backend/src/config.rs` L244–251), `keygen admin-key` (`local_backend/src/main.rs` L120–126) and the
  `generate_key` tool (`keybroker/src/bin/generate_key.rs` L42) all go through it.
- `const_hex::decode` (const-hex 1.19.1, Convex's `Cargo.lock` at both commits, `src/lib.rs` L523–545 and
  `strip_prefix` L702–707): an odd length is refused first, then one leading `0x` or `0X` is dropped, then the
  rest must be hex digits of either case. So `0x0x…` is refused (the second `x` is not hex), `0x` alone is 0
  bytes, `0x` + 63 digits is an odd length.
- Everything is derived from the 32 bytes, never from the text: `KeyBroker::new` (`keybroker/src/broker.rs`
  L915–947) builds the legacy encryptor from `secret.as_bytes()` (`legacy_encryptor.rs` L13–18) and every
  purpose's encryptor (admin keys, action callbacks, cursors, data sync, export downloads, journals, store
  files) with `derive_from_secret`, KBKDF over `secret.as_bytes()` (`encryptor.rs` L57–69). The text is
  neither stored nor hashed. So any spelling of the same bytes (`0x`, `0X`, upper or lower case) is the same
  secret.

### 7.2 Captured from the oracle

`keygen admin-key --instance-name n --instance-secret <s>` (a key is `n|01…`, random each time):

```
<64 hex>                  a key, exit 0
0x<64 hex>, 0X<64 hex>    a key, exit 0
0x<mixed-case 64 hex>     a key, exit 0
0x0x<64 hex>              Error: Couldn't hexdecode key, exit 1
x<64 hex>                 Error: Couldn't hexdecode key, exit 1
0x<65 hex>, 0x<63 hex>    Error: Couldn't hexdecode key, exit 1
0x                        Error: Hex-decoded key was 0 bytes, not 32, exit 1
0xab                      Error: Hex-decoded key was 1 bytes, not 32, exit 1
```

The backend started with `0x0x<64 hex>`, `0x` or `0x<65 hex>` exits 1 with the same lines. Started (with
`--disable-beacon`) on one store under `0x<64 hex>`, then `<64 hex>`, then `0X<64 hex>`, each time
`/api/check_admin_key` answered 200 to the keys `keygen` issued for all three spellings, and 401
`BadAdminKey` to another secret's key. Keys are interchangeable across spellings because the bytes are the same.

### 7.3 What bunvex changes

- `server/src/local-backend.ts` `instanceSecretError` checks the secret as `const_hex::decode` does: one
  `0x` / `0X` dropped, then hex of an even length, then 32 bytes. It covers `--instance-secret`,
  `INSTANCE_SECRET` (DV-525) and `keygen admin-key`.
- `core/src/kbkdf.ts` `instanceSecretBytes` reads `0x`/`0X` + 64 hex digits as those 32 bytes. Every admin key
  (`adminKeyCipherKey`, the server's `derivedKey("admin key")`, `bunvex admin-key`), cursor and data-sync key
  goes through it.
- The engine keeps its secret in one spelling (`canonicalInstanceSecret`: a hex secret as its 64 lowercase
  digits without the prefix, as Convex's `Display` writes it). `secretKey(purpose)` hashes the secret's text
  (the storage, export and import tokens), so without that step a `0x` or uppercase spelling would give other
  tokens. With it, they don't, and an uppercase secret now derives the same tokens as its lowercase spelling.
  Any other string (a library caller's secret that is not hex) is kept as it is.

There is nothing to measure: the secret is read once per start.

### 7.4 Divergences

None. DV-526 stays unused.

### 7.5 Tests

- `core/test/instance-secret.test.ts`: every spelling gives the same bytes and canonical text. Non-hex strings
  (`0x0x…`, `0x` + 66 digits, `0x`) keep their own. An engine restarted on one store under each spelling
  derives the same `secretKey` and `derivedKey` and reads the first one's cursor. `0x0x…` does neither.
- `server/test/local-backend.test.ts`: the §7.2 messages without the oracle, by flag and by `INSTANCE_SECRET`.
  Keys from `keygen` under four spellings (one through the variable) check out with the bare secret's cipher
  and on a backend started on one store under `0x`, bare and `0X` + uppercase in turn. Another secret's key
  gets 401.
- `differential/test/backend-flags.test.ts` (oracle): the refusals (`0x0x…`, `0x`, `0Xab`, `0x` + 65 digits,
  `x…`) at the start and in `keygen`, compared, plus `keygen`'s exit 0 for `0x` and `0X` + uppercase.
- `differential/test/instance-secret-0x.test.ts` (oracle): Convex's backend is started, and Convex's CLI
  deploys, under `0x<hex>`. bunvex's is started, and bunvex's CLI deploys, under `0X<HEX>` through
  `INSTANCE_SECRET`. Each accepts the keys both binaries' `keygen` issued under four spellings, and refuses
  another secret's.
- **Sabotage** (each restored, `git diff` clean after; failures in core / server / oracle-flags / oracle-0x):
  the check drops no prefix (0 / 2 / 4 / 1); it drops every `0x`, so `0x0x…` passes (0 / 1 / 2 / 0); it drops
  a lowercase `0x` only (0 / 2 / 2 / 1); the bytes ignore the prefix (1 / 1 / 0 / 1); the engine keeps the raw
  text (1 / 0 / 0 / 0); the canonical text keeps the case (1 / 0 / 0 / 0).
