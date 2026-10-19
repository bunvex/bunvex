// The function sandbox (STUDY-168, STUDY-171 §7): an app's code in a separate process. This package is the child
// runtime (`child.ts`), the wire protocol (`protocol.ts`, `frames.ts`) and the host's side of one child
// (`SandboxProcess`). Nothing in the server uses it yet: `BUNVEX_FUNCTION_SANDBOX=process` still fails at start,
// until calls run over the bridge (STUDY-168 PR 3).
export { evaluatedValue, NOT_A_SCHEMA, UnserializableAuthConfigError } from "./default-export.ts";
export { FrameReader, FrameTooLargeError, frame } from "./frames.ts";
export {
  type ChildLoad,
  HANDSHAKE_TIMEOUT_MS,
  SandboxError,
  type SandboxFailure,
  SandboxProcess,
  type SandboxProcessOptions,
} from "./host.ts";
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
