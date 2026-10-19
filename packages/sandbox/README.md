# @bunvex/sandbox

The function sandbox (AD-44, STUDY-168): an app's code in a separate process, so the operating system, not `node:vm`,
is the wall around it. Private for now: nothing uses it by default, and `BUNVEX_FUNCTION_SANDBOX=process` still fails
at start until calls run over the bridge.

- `src/child.ts`: the child. It loads a push with the server's own loader (`@bunvex/server/executor`), so its
  analysis, globals and errors are those of an in-process load, and answers the host's requests.
- `src/protocol.ts`, `src/frames.ts`: the messages and their framing: a 4-byte length, then JSON, on the child's
  fd 3 (a socket, both ways). Values inside are in the value JSON format. What a child sends is checked for its
  shape, and a frame over `MAX_MESSAGE_BYTES` is refused from its header.
- `src/host.ts`: `SandboxProcess.start()` spawns a child and waits for its `hello`; `load()` analyzes a push in it,
  `evaluate()` / `evaluateDefault()` evaluate a schema or an auth config. A child that crashes, sends a bad or
  oversized message, or does not start in 5 s is killed, and what waits on it fails with a `SandboxError`.

The design and its measurements: [STUDY-171 §7](../../docs/study/STUDY-171-function-sandbox-seam.md). The parity
test (`test/analysis-parity.test.ts`) runs a corpus written by `bun scripts/sandbox-parity-corpus.ts`; write it
again when an example app or a pushed-code suite of the server changes.
