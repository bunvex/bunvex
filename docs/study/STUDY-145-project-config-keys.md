# STUDY-145 — The remaining `convex.json` keys in `bunvex.json`
<!-- index: The remaining `convex.json` keys in `bunvex.json`: `node` and `bundler` checked with Convex's messages in its key order; `node.nodeVersion` sent with the push, checked by the deployment ("18" and unknown versions a 400 `InvalidConfig`), stored on the package and diffed in the audit log; `bundler.includeSourcesContent`; `externalPackages` left to its own track | implemented -->

- **Status:** implemented
- **Convex source read:** commit `4577b903` of get-convex/convex-backend; the messages checked against the
  `convex` 1.46.0 CLI (its `cli.bundle.cjs`, run on each file)
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md) (deploy2), [STUDY-36](STUDY-36-codegen.md) and
  [STUDY-65](STUDY-65-convex-tests-application-client-cli.md) G-L2 (`bunvex.json`'s checks),
  [STUDY-117](STUDY-117-typecheck-command.md) (`typescriptCompiler`), [STUDY-134](STUDY-134-system-row-shapes.md)
  (`_source_packages`), DV-87 (Node actions run in Bun), DV-170 (`bunvex.json`)

The platform row "Other `convex.json` keys: `functions` dir, `node.externalPackages`, `node.nodeVersion`,
`bundler.includeSourcesContent`, `typescriptCompiler`". `node.externalPackages` is out of scope (another track
builds it); `functions` and `typescriptCompiler` were already read (STUDY-35, STUDY-117).

## 1. How Convex does it

**The file** (`npm-packages/convex/src/cli/lib/config.ts`): `ProjectConfig` (`:77-118`) and its zod schema
(`createProjectConfigSchema`, `:317-380`), in this key order: `functions` (string, default `"convex/"`), `node`
(`NodeSchema`, `:266-277`: `externalPackages` an array of strings, default `[]`; `nodeVersion` an optional
string), `codegen`, `bundler` (`BundlerSchema`, `:292-299`: `includeSourcesContent` a boolean, default
`false`), `generateCommonJSApi`, `typescriptCompiler` (`"tsc" | "tsgo"`), then `$schema`, `authKit`, `aiFiles` and
the deprecated `project`, `team`, `prodUrl`.

`parseProjectConfig` (`:396-479`) reports zod's first issue as ``` `<path>` in `convex.json`: <message> ```, so a
file with several bad keys names the first in the schema's order. What the 1.46.0 CLI prints:

| `convex.json` | message |
|---|---|
| `{"node":5}` (`null`, `[]`) | `` `node` in `convex.json`: Expected object, received number `` (`null`, `array`) |
| `{"node":{"nodeVersion":20}}` (`null`) | `` `node.nodeVersion` in `convex.json`: Expected string, received number `` (`null`) |
| `{"bundler":5}` (`null`, `[]`) | `` `bundler` in `convex.json`: Expected object, received number `` |
| `{"bundler":{"includeSourcesContent":"yes"}}` | `` `bundler.includeSourcesContent` in `convex.json`: Expected boolean, received string `` |
| `{"node":{"nodeVersion":1},"codegen":{"fileType":"x"}}` | the `node.nodeVersion` one (`node` comes before `codegen`) |
| `{"bundler":{"includeSourcesContent":1},"codegen":{"fileType":"x"}}` | the `codegen.fileType` one (`codegen` before `bundler`) |
| `{"typescriptCompiler":"x","generateCommonJSApi":"y"}` | the `generateCommonJSApi` one |
| `{"node":{"nodeVersion":"16"}}` | accepted: the CLI checks only that it is a string |

**`node.nodeVersion`.** The CLI sends it as `nodeVersion` in the deploy2 request when it is set
(`lib/components.ts:448`; `deployApi/startPush.ts`: `z.optional(z.string())`). The deployment checks it first,
in `StartPushRequest::into_project_config` (`crates/application/src/deploy_config.rs:1193-1205`), which
`start_push`, `evaluate_push` and `evaluate_schema` all call before anything else
(`crates/local_backend/src/deploy_config2.rs:318`, `:345`, `:372`), mapping its error to a 400 `InvalidConfig`
with the error's text:

- `NodeVersion::from_str` (`crates/model/src/source_packages/types.rs:41-53`) takes `"18"`, `"20"`, `"22"`,
  `"24"`; anything else is "Invalid node version: <value>".
- `"18"` is then refused: "Node 18 is no longer supported. Upgrade to a newer Node version
  (https://docs.convex.dev/config/convex.json#configuring-the-nodejs-version)."

The version is stored on the push's source package (`_source_packages.nodeVersion`, `SerializedSourcePackage`,
`types.rs:260-275`), answered by `get_config_hashes` as `nodeVersion` (the latest package's,
`crates/local_backend/src/deploy_config.rs:246-249`), and diffed in the push's audit event:
`push_config_with_components.node_version_diff` is `{previous_version, next_version}` when the latest package's
version changed, else null (`crates/application/src/deploy_config.rs:905-945`; `SerializedNodeVersionDiff`). In
Convex's cloud it picks the AWS Lambda runtime of Node actions. A self-hosted Convex runs Node actions with the
local executor (`crates/node_executor/src/local.rs:129-181`), on the `node` it finds (the `.nvmrc` version
under nvm, else the one on `PATH`): the setting does not change the runtime there.

The CLI's verbose push (`--verbose`) prints "Change the server's version for Node.js actions:" with `[-]` /
`[+]` lines (`diffConfig`, `config.ts:882-912`), from `get_config_hashes`'s `nodeVersion`.

**`bundler.includeSourcesContent`.** Passed to esbuild's `sourcesContent` for every bundle
(`lib/components.ts:380-381`, `bundler/index.ts:191-222`). False (the default) writes source maps with no
`sourcesContent` key at all (checked with esbuild 0.27: `version`, `sources`, `mappings`, `names`); true adds the
original sources. The maps are pushed with the modules and stored in the package; the deployment reads only
their `mappings` and `sources` (error frames, function positions), so the only effect is the package's size.

**`functions`** is the functions directory, and is sent as written in the push's `functions` field (the deployment reads
it into its `ConfigMetadata`). **`typescriptCompiler`** picks the typecheck's compiler (STUDY-117).

## 2. What an app can observe

- The CLI's messages for a malformed `node` or `bundler`, and which one a file with several bad keys gets.
- A push with `node.nodeVersion` "20", "22" or "24" succeeds and stores it; "18" and any other string fail with
  the deployment's 400 `InvalidConfig` messages, before anything is pushed.
- `get_config_hashes`'s `nodeVersion`, `_source_packages.nodeVersion`, and the audit log's `node_version_diff`.
- The pushed source maps with or without `sourcesContent` (the package's size).
- Self-hosted: Node actions run the same whatever the version.

## 3. How bunvex does it

- `readProjectConfig` (`packages/cli/src/deploy.ts`) checks `node` and `node.nodeVersion`, and `bundler` and
  `bundler.includeSourcesContent`, with Convex's messages, and checks the keys in Convex's schema order (which also
  puts `generateCommonJSApi` before `typescriptCompiler`, as Convex's).
- `bunvex deploy` (and `dev`) sends `nodeVersion` when it is set, and `functions` as configured (`"bunvex/"` by
  default, as Convex's `"convex/"`).
- The server's `parseNodeVersion` (`packages/server/src/push.ts`) runs first in `start_push`, `evaluate_push`
  and `evaluate_schema`: Convex's two messages as 400 `InvalidConfig`, not prefixed with "Hit an error while
  pushing" (Convex maps them before the push). A non-string is the body's 400 `BadJsonBody` (Convex's extractor
  refuses it; the CLI never sends one).
- The version goes with the push to `finish_push`, onto the package's `_source_packages` row
  (`writePackage`), into `get_config_hashes`, and into `push_config_with_components.node_version_diff`.
- `bundleFunctions` (`packages/cli/src/bundle.ts`) takes `includeSourcesContent`. Bun always writes
  `sourcesContent`, so without the setting the key is deleted, leaving the map as esbuild writes it.
- Node actions run in Bun (DV-87): as on a self-hosted Convex, the version does not change how they run.

`node.externalPackages` is neither checked nor read (the other track's); unknown keys are still kept without
Convex's "Unknown property" warning (the codegen row).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | The Node 18 message has no docs link | DV-04 (never Convex's docs) | covered by DV-04 |
| — | `bunvex.json`, `"bunvex/"` | DV-170 | covered by DV-170 |

No new divergence. Not built (gaps, not choices): `--verbose`'s Node version diff (bunvex's deploy has no
`--verbose`); the backend storing `functions` (`get_config_hashes` answers `functions: ""`); a non-string
`nodeVersion`'s body error is serde's message abridged.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

- `packages/cli/test/codegen.test.ts`, "bunvex.json checks": the messages above, each from the 1.46.0 CLI on the
  same file (oracle run once, not at test time), the key order, and that any `nodeVersion` string passes.
- `packages/cli/test/deploy.test.ts`:
  - "the bundle": with `includeSourcesContent` the maps carry the sources (the positions still match them);
    without it, the same maps with no `sourcesContent` key;
  - "bunvex.json's node.nodeVersion and bundler.includeSourcesContent reach the deployment": none, "22", "24",
    none again — `_source_packages`, `get_config_hashes` and the four `node_version_diff` values;
    `includeSourcesContent` grows the stored package by at least the sources; "18", "16" and "20.x" refused with
    Convex's messages and nothing pushed.
- `packages/server/test/push.test.ts`, "nodeVersion: Convex's 400 InvalidConfig…": the three endpoints, each
  message and code, a non-string, and "20" / "22" / "24" / null / absent accepted.

**Sabotage** (each restored, `git diff` clean after):

| Break | Failed |
|---|---|
| `sourcesContent` kept in every map | "the bundle", the deploy test |
| `deploy` ignores `bundler.includeSourcesContent` | the deploy test (package size) |
| `deploy` does not send `nodeVersion` | the deploy test |
| the server accepts "18" | the server test, the deploy test |
| the package row stores no version | the deploy test |
| no `node_version_diff` | the deploy test |
| `generateCommonJSApi`'s type unchecked | two config cases |
| `node.nodeVersion`'s type unchecked | three config cases |

(The server first wrapped `InvalidConfig` in "Hit an error while pushing:"; the server test caught it.)

**Measurement:** none needed. The config is read once per push, and deleting a key from each source map is
negligible next to bundling.

## 6. Open questions

None.
