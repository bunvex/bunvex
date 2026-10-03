// The server under test, as a child process (STUDY-57 §3.1): started, killed (SIGKILL: no shutdown, no
// flush beyond what was already acknowledged) and started again on the same data, on a new port (a proxy
// keeps the clients' address: proxy.ts).
import type { Subprocess } from "bun";

export type ServerOptions = {
  /** PERSISTENCE: memory | sqlite | postgres | mysql | mongodb. */
  store: string;
  /** DATA, for the embedded stores (memory's log, SQLite's file). */
  dataDir: string;
  /** Extra environment (PERSISTENCE_URL, DO_NOT_REQUIRE_SSL, …). */
  env?: Record<string, string | undefined>;
};

export class ServerProcess {
  private child: Subprocess | null = null;
  port = 0;
  /** Its output, kept for a failure report. */
  readonly output: string[] = [];

  constructor(private readonly opts: ServerOptions) {}

  /** Start the server; `env` adds to the options' environment for this start only (e.g. a clock skew). */
  async start(env?: Record<string, string | undefined>): Promise<number> {
    const child = Bun.spawn(["bun", "--preload", `${import.meta.dir}/skew.ts`, `${import.meta.dir}/server.ts`], {
      env: {
        ...process.env,
        PERSISTENCE: this.opts.store,
        DATA: this.opts.dataDir,
        DURABLE: "1",
        PORT: "0",
        ...this.opts.env,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    this.child = child;
    void child.exited.then((code) => {
      if (this.child === child) this.output.push(`[exit] ${code}`);
    });
    const ready = new Promise<number>((resolve, reject) => {
      const decoder = new TextDecoder();
      const read = async (stream: ReadableStream<Uint8Array>, name: string) => {
        const reader = stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          const text = decoder.decode(value);
          this.output.push(`[${name}] ${text}`);
          const m = /ready (\d+)/.exec(text);
          if (m) resolve(Number(m[1]));
        }
      };
      void read(child.stdout as ReadableStream<Uint8Array>, "out");
      void read(child.stderr as ReadableStream<Uint8Array>, "err");
      void child.exited.then((code) => reject(new Error(`the server exited (${code}) before it was ready`)));
    });
    this.port = await ready;
    return this.port;
  }

  /** Whether the process is running: a store failure ends it (fail-stop) without anyone killing it. */
  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Send a signal (the store fault switches: store-faults.ts); resolves once the server printed `expect`. */
  async signal(sig: "SIGUSR1" | "SIGUSR2", expect: string) {
    const seen = this.output.length;
    if (this.child) process.kill(this.child.pid, sig); // (Subprocess.kill does not deliver SIGUSR1/2 here)
    while (!this.output.slice(seen).some((l) => l.includes(expect))) await Bun.sleep(2);
  }

  /** SIGKILL: the process dies at once, as a crash would. */
  async kill() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.kill("SIGKILL");
    await child.exited;
  }

  /** A clean shutdown (SIGTERM), at the end of a run. */
  async stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(5000).then(() => child.kill("SIGKILL"))]);
    await child.exited;
  }
}
