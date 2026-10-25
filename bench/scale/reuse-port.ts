// STUDY-184. Two processes bind one port with SO_REUSEPORT and each answers with its own id.
// Linux should share the connections. macOS gives them all to one process (STUDY-24 §4.7).
// Listens on 127.0.0.1 only. Nothing is written to a store.
const port = Number(process.env.PORT ?? 3299);
const requests = Number(process.env.REQUESTS ?? 400);
const id = process.env.REUSE_ID;

if (id === undefined) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const kids = [0, 1].map((n) =>
    Bun.spawn([process.execPath, import.meta.path], {
      env: { ...env, REUSE_ID: String(n), PORT: String(port) },
      stdout: "pipe",
      stderr: "inherit",
    }),
  );
  const ready = Promise.all(
    kids.map(async (kid) => {
      const text = await new Response(kid.stdout).text();
      return text;
    }),
  );
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: "close" } });
      if (res.ok) {
        await res.text();
        break;
      }
    } catch {
      // Not bound yet.
    }
    await Bun.sleep(50);
  }
  const counts = new Map<string, number>();
  let failed = 0;
  await Promise.all(
    Array.from({ length: requests }, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: "close" } });
        const body = (await res.text()).trim();
        if (!res.ok) failed++;
        else counts.set(body, (counts.get(body) ?? 0) + 1);
      } catch {
        failed++;
      }
    }),
  );
  for (const kid of kids) kid.kill("SIGTERM");
  const logs = await ready;
  const a = counts.get("0") ?? 0;
  const b = counts.get("1") ?? 0;
  const max = Math.max(a, b);
  console.log(
    JSON.stringify({
      port,
      requests,
      failed,
      counts: { "0": a, "1": b },
      // 1.0 is an even split. 0 is every request on one process.
      balance: max === 0 ? 0 : Math.min(a, b) / max,
      logs: logs.map((log) => log.trim()).filter(Boolean),
    }),
  );
  process.exit(failed > 0 || counts.size < 2 ? 1 : 0);
}

let n = 0;
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  reusePort: true,
  fetch() {
    n++;
    return new Response(id);
  },
});
console.log(`ready ${id} ${server.port}`);
process.on("SIGTERM", () => {
  console.log(`count ${id} ${n}`);
  server.stop(true);
  process.exit(0);
});
