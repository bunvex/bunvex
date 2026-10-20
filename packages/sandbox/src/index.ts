// The function sandbox (STUDY-168, STUDY-171 §7): an app's code in a separate process. This package is the child
// runtime (`child.ts`), the wire protocol (`protocol.ts`, `frames.ts`) and the host's side of one child
// (`SandboxProcess`), and the `process` executor (`createProcessExecutor`): queries and mutations run in a child,
// each `ctx` operation answered on the host's transaction (STUDY-171 §8). The server cannot import this package: its
// entry point provides the executor (`provideProcessExecutor(createProcessExecutor)`).
export { evaluatedValue, NOT_A_SCHEMA } from "./default-export.ts";
export { createProcessExecutor, ProcessExecutor, RemoteCodeVersion } from "./executor.ts";
export { FrameReader, FrameTooLargeError, frame } from "./frames.ts";
export {
  type CallSink,
  type ChildLoad,
  HANDSHAKE_TIMEOUT_MS,
  SandboxError,
  type SandboxFailure,
  SandboxProcess,
  type SandboxProcessOptions,
} from "./host.ts";
export { BACKSTOP_SLACK_MS } from "./host-call.ts";
export {
  BadMessageError,
  type EvaluatedDefault,
  MAX_MESSAGE_BYTES,
  MAX_VALUE_SIZE,
  PROTOCOL_VERSION,
  parseChildMessage,
  type ToChild,
  type ToHost,
} from "./protocol.ts";
export { describeVersion, type LoadedVersion, loadedVersion, type RemoteFunction } from "./version.ts";
export { decode, encode, MAX_WIRE_DEPTH } from "./wire.ts";
