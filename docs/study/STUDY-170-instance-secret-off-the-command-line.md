# STUDY-170 — The instance secret off the command line
<!-- index: The instance secret off the command line: Convex's binary takes `--instance-secret` only and its image and CLI put it on argv, readable by every local user; bunvex's executable reads `INSTANCE_SECRET` too (the flag wins), and `bunvex dev` and the Docker scripts pass it there (STUDY-168 Q11) | implemented (this PR); DV-525 (owner, 2026-10-19) -->

- **Status:** implemented (this PR); DV-525 decided (owner, 2026-10-19: move the secret off the command line)
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend
- **Related:** STUDY-168 Q11 (found it), STUDY-40 (the executable, `bunvex dev`'s local deployments), STUDY-38
  (the Docker image), STUDY-34 (admin keys)

On Linux any user of the machine can read every process's command line (`/proc/<pid>/cmdline`, `ps`); its
environment (`/proc/<pid>/environ`) only its owner and root can. The instance secret is the root of every admin
key and of the signed cursors, so passed as `--instance-secret <hex>` it leaks to every local user while the
backend runs. STUDY-168 Q11 found that bunvex passed it that way everywhere, as Convex does.

## 1. How Convex does it

**The executable takes the flag only.** `crates/local_backend/src/config.rs`:

- L81–87: `instance_name` and `instance_secret` are `#[clap(long, requires = …)]` options, each requiring the
  other. No `env =` attribute: the binary never reads `INSTANCE_SECRET`. The same file does use clap's
  `env =` elsewhere (L123, `--disable-beacon` / `DISABLE_BEACON`), so the absence is a choice, not a missing
  clap feature.
- L244–251: `secret()` turns a missing one into `--instance-secret is required. Generate one with
  \`openssl rand -hex 32\``; `DeploymentSecret::try_from` checks it is 32 bytes of hex.
- L169–176: `keygen admin-key` (`AdminKeyArgs`) takes `--instance-name` and `--instance-secret`, both required
  flags, no variable either (used at `main.rs:121`).
- There is no `--instance-secret-file` and no `_FILE` variable anywhere in `crates/` or `self-hosted/`.

**The Docker image takes it by environment, then puts it on argv.**

- `self-hosted/docker/docker-compose.yml:35–36` passes `INSTANCE_NAME` and `INSTANCE_SECRET` from the host into
  the container's environment (Convex's own test harness starts it that way:
  `crates/backend_harness/src/provision.rs:601`).
- `self-hosted/docker-build/read_credentials.sh:9–15`: `INSTANCE_SECRET` is the environment's, else the volume's
  `credentials/instance_secret`, else `openssl rand -hex 32`; exported, and saved to the volume.
- `self-hosted/docker-build/run_backend.sh:58–60` then execs `./convex-local-backend … --instance-secret
  "$INSTANCE_SECRET"`: inside the container, the backend's command line holds the secret, and so does the
  host's process table (a container's processes are the host's).
- `generate_admin_key.sh:7` passes it on argv to `generate_key` as well.

**The CLI passes it on argv.** `npm-packages/convex/src/cli/lib/localDeployment/run.ts`:

- L82–98: the backend's `commandArgs` include `"--instance-secret", args.instanceSecret`;
- L117–119: a `spawnSync(binary, [...commandArgs, "--help"])` check that the binary runs (the secret on that
  command line too);
- L164–171: the verbose log of the command redacts it (`[REDACTED]`), so Convex knew the value was sensitive,
  but L174 spawns the backend with it in argv anyway.
- `secrets.ts:42–48`: `keygen admin-key --instance-name … --instance-secret …` through `execFile`.

**The docs** (`self-hosted/advanced/running_binary_directly.md:25–29, 59–64`) export `INSTANCE_SECRET` in the
shell, then pass it as `--instance-secret "$INSTANCE_SECRET"`.

## 2. What an app can observe

Nothing: the secret is the operator's. What whoever runs the server observes is how to hand it over: with
Convex, the executable's flag (and the image's variable, which its script turns into the flag).

## 3. How bunvex does it

**The executable** (`packages/server/src/local-backend.ts`) reads `INSTANCE_SECRET` when `--instance-secret` is
absent: clap's precedence for an `env =` option (the flag, then the variable), and an empty value is none, as
clap's and the shell scripts' `${INSTANCE_SECRET:-…}`. Convex's variable name, as its image already takes it
(no "convex" in it, so rule 5 keeps it). Everything else is unchanged:

- the value is checked as the flag's (`Hex-decoded key was 2 bytes, not 32`, `--instance-secret must be
  hex-encoded`);
- `--instance-name` without a secret is still refused, but the variable's counts as one;
- with neither, the messages are Convex's, word for word, as before;
- `keygen admin-key` reads it too (same precedence, same messages);
- `--help` lists it (`[env: INSTANCE_SECRET]`, clap's notation).

Once the flags are parsed, the program deletes `INSTANCE_SECRET` from its own environment, so nothing it starts
inherits it: the one child the backend starts is an external package's `bun install` (STUDY-148), with the
server's environment, and with `pm trust --all` its packages' lifecycle scripts run there. External packages
also run in the server's realm and see its `process.env` (DV-472), where a Convex action's `process.env` holds an
allowlist of the process's variables plus the deployment's (bunvex's `env-scope.ts` follows it), so removing it
there is closer to Convex, not further.

**`bunvex dev`** (`packages/cli/src/local-deployment.ts`) gives the secret to `keygen admin-key` and to the
backend in `INSTANCE_SECRET`, set explicitly (a stray `INSTANCE_SECRET` in the user's shell is not the
deployment's). An existing deployment can stay on an older downloaded release (the upgrade prompt, or
`--backend-version`), and `precompiled-2026-10-02-e48acfb` and `precompiled-2026-10-09-1049627` read the flag
only. Like Convex's CLI, which runs the binary with `--help` before starting it (run.ts L117), `bunvex dev` runs
`<binary> --help` first: when the help names `INSTANCE_SECRET` the secret goes in the environment, otherwise
(an older release) as the flag, as before. The check costs one short spawn per start.

**The Docker image** (`docker/run_backend.sh`, `generate_admin_key.sh`): `read_credentials.sh` already exports
`INSTANCE_SECRET`, so the scripts drop `--instance-secret` and the backend reads the variable. The compose file
and its variables are unchanged.

**The harnesses** that start bunvex's own backend pass it by environment too: `examples/_harness`,
`packages/differential/harness/backends.ts` (Convex's oracle binary keeps the flag, the only way it takes it),
`bench/index-cache-e2e.ts`, `scripts/smoke-binary.sh`. In-process tests pass `instanceSecret` to the engine
and are not affected.

**Docs:** `docker/README.md` (the variables table, the executable's commands), the site's install line,
`ARCHITECTURE.md`, `docs/upgrading.md`.

**A file option** (`--instance-secret-file`, `INSTANCE_SECRET_FILE`) is not built: Convex has none. It would help
with Docker or Kubernetes secrets mounted as files; the environment already keeps the value from other users, so
it is optional and left for the owner to ask for.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-525 | `bunvex-local-backend` and its `keygen admin-key` read `INSTANCE_SECRET` when `--instance-secret` is absent (the flag wins), and remove it from the process's environment once read; `bunvex dev`, the Docker scripts and bunvex's harnesses pass the secret in the environment, not as the flag (`bunvex dev` still passes the flag to a release from before the variable). Convex's binary takes the flag only, and its CLI and image put the secret on the command line | a command line is readable by every user of the machine (`/proc/<pid>/cmdline`, `ps`), the environment by its owner only (STUDY-168 Q11) | owner, 2026-10-19: approved moving it off the command line |

The flag keeps working, with Convex's messages; an operator who uses it gets Convex's behaviour.

## 4b. Additions (beyond Convex)

None beyond DV-525 (the variable is how Convex's image already takes the secret; what differs is who reads it).

## 5. Tests

- `packages/server/test/local-backend.test.ts`:
  - the variable is read without the flag, and the flag wins over it (`--instance-secret x` and
    `--instance-secret=x`);
  - `--instance-name` is satisfied by the variable;
  - with neither (no variable, or an empty one), both of Convex's messages, unchanged;
  - a bad value in the variable gets the flag's messages;
  - `parseLocalBackendFlags` does not read `process.env` unless given it;
  - `keygen admin-key` reads it, the flag winning (each key checked with `checkAdminKey` under each secret);
    with neither, its message;
  - the program takes it from its environment, gets past the flags to the start, and leaves the variable out
    of its environment afterwards; `--help` names it.
- `packages/cli/test/local-deployment.test.ts`: `bunvex dev`'s local deployment with a stand-in executable that
  records each run's arguments and `INSTANCE_SECRET` and its pid:
  - keygen and the backend get the secret in their environment, not in their arguments, even with another
    `INSTANCE_SECRET` in the CLI's environment;
  - the running backend's command line (`ps -o args= -p <pid>`) has no secret;
  - keygen's key opens the backend;
  - an executable whose `--help` does not name the variable gets `--instance-secret` (both runs).
- `scripts/smoke-binary.sh` (CI, Linux and macOS): keygen with the variable; the backend started with it, its
  `ps -o args=` without the secret; the missing-secret check runs with the variable unset.
- `docker/smoke.sh` (CI): the container's process 1 is the backend, and its `/proc/1/cmdline` has no secret.

Both smokes passed locally (macOS; the binary smoke against the source entry, the Docker one on Docker
Desktop), and each failed on its sabotage below.

**Sabotage** (each restored, `git diff` checked after each):

| # | Sabotage | Failed |
|---|---|---|
| S1 | the executable ignores the variable (`f.instanceSecret ??= secretFromEnv(env)` removed) | local-backend: the env test (`Expected: { instanceSecret }`, got the missing-secret message), the program test |
| S2 | the variable wins over the flag (`f.instanceSecret = secretFromEnv(env) ?? f.instanceSecret`) | local-backend: the precedence expectations |
| S3 | keygen ignores the variable | local-backend: the keygen test (exit 2) |
| S4 | the variable kept in the environment (the `delete` removed) | local-backend: the program test (`env` still has it) |
| S5 | `bunvex dev` puts the secret on the backend's command line again (`secretFor` always the flag) | local-deployment: the DV-525 test (argv contains the secret) |
| S6 | `bunvex dev` never falls back to the flag (`readsSecretFromEnv` always true) | local-deployment: the DV-525 test (the older executable's runs have no `--instance-secret`) |
| S7 | `scripts/smoke-binary.sh` with `--instance-secret "$SECRET"` back on the backend's command line | the smoke: "the instance secret is on the backend's command line" |
| S8 | `docker/run_backend.sh` with `--instance-secret "$INSTANCE_SECRET"` back | `docker/smoke.sh`: "the instance secret is on the backend's command line" |

## 6. Open questions

- A file option (`--instance-secret-file` / `INSTANCE_SECRET_FILE`), for secrets mounted as files: Convex has
  none; not built (optional, the owner's call).
