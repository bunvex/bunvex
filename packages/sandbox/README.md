# @bunvex/sandbox

The function sandbox (AD-44, STUDY-168): an app's code in a separate process, so the operating system, not `node:vm`,
is the wall around it. Private for now: nothing uses it by default. With `BUNVEX_FUNCTION_SANDBOX=process` and
`BUNVEX_FUNCTION_SANDBOX_ISOLATION=none` (no OS isolation yet: not a security boundary), a server's pushed queries and
mutations run in its children; actions, HTTP actions, components and rooms do not yet.

- `src/child.ts`: the child. It loads a push with the server's own loader (`@bunvex/server/executor`), so its
  analysis, globals and errors are those of an in-process load, and answers the host's requests.
- `src/protocol.ts`, `src/frames.ts`: the messages and their framing: a 4-byte length, then JSON, on the child's
  fd 3 (a socket, both ways). Values inside are in the value JSON format. What a child sends is checked for its
  shape, and a frame over `MAX_MESSAGE_BYTES` is refused from its header.
- `src/host.ts`: `SandboxProcess.start()` spawns a child and waits for its `hello`; `load()` analyzes a push in it,
  `evaluate()` / `evaluateDefault()` evaluate a schema or an auth config. A child that crashes, sends a bad or
  oversized message, or does not start in 5 s is killed, and what waits on it fails with a `SandboxError`.

- `src/executor.ts`: the `process` executor (`createProcessExecutor`, which `bunvex-local-backend` provides to the
  server with `provideProcessExecutor`): a child per code version, its functions stand-ins the engine runs.
- `src/host-call.ts`: a call on the host: its messages read in the call's async context, each operation run on the
  function's real `ctx`, checked (the running call, its kind, its `db`), the child's user time charged, the backstop.
- `src/child-call.ts`, `src/child-db.ts`: a call in the child: the real handler, a `ctx` of operations, the
  synchronous APIs from what the call carries, core's determinism and user timer.
- `src/wire.ts`: values, and what is not one, across the wire, so the engine's checks give the same words.

The design and its measurements: [STUDY-171 §7, §8](../../docs/study/STUDY-171-function-sandbox-seam.md). The parity
test (`test/analysis-parity.test.ts`) runs a corpus written by `bun scripts/sandbox-parity-corpus.ts`; write it
again when an example app or a pushed-code suite of the server changes. `test/bridge-parity.test.ts` deploys one
module to a `vm` server and a `process` server and compares every answer and read set; `test/process-preload.ts`
runs any suite's in-process servers under `process`.
