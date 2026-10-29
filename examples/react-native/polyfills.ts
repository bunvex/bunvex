// What the app needs from the JavaScript runtime before bunvex's packages load: `TextEncoder` and `TextDecoder`.
// Hermes has `TextEncoder`; if it has no `TextDecoder`, this adds both and says so in Metro's log, so the example
// shows whether a React Native app needs it.
if (typeof TextDecoder === "undefined") {
  console.warn("bunvex example: this runtime has no TextDecoder; using fast-text-encoding");
  require("fast-text-encoding");
}
