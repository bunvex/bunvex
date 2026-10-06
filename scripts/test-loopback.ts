// Preloaded by `bun test` (bunfig.toml): a server a test starts without a hostname listens on 127.0.0.1, not
// on every address (STUDY-132 §1.2).
//
// Why: the tests start their servers on port 0 and talk to them at `http://127.0.0.1:<port>`. On macOS, a
// wildcard listener can be given a port that another process already listens on at 127.0.0.1 (the kernel
// only refuses an exact address match when both sockets set SO_REUSEADDR, as Bun's do), and a connection to
// 127.0.0.1 then reaches the more specific listener: an editor's helper, or another test run's server. The
// test sees a stranger's answer (a 400 with no body, a 404, `null`). A test server bound to 127.0.0.1 is never
// given such a port. Production servers are not affected: this file is loaded by the test runner only.
const serve = Bun.serve;

Bun.serve = ((options: Parameters<typeof serve>[0]) => {
  const o = options as { hostname?: string; unix?: string };
  return serve(
    o.hostname === undefined && o.unix === undefined ? ({ ...options, hostname: "127.0.0.1" } as never) : options,
  );
}) as typeof serve;
