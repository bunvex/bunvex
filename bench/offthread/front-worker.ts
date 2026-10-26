// STUDY-190 prototype (d), a front thread: a Bun.serve on the public port (reusePort, so the kernel spreads
// connections over the front threads on Linux) that reads each request, hands it to the main thread as strings,
// and writes the main thread's answer. HTTP parsing, the Request and Response objects of the public connection
// and their writes happen here; the main thread runs the bunvex server's handler on a copy of the request.
// The wire is one string each way (a structured clone of header arrays costs the main thread more than it saves,
// §4.4): `id \0 method \0 url \0 name \0 value … \1 body` in, `id \0 status \0 name \0 value … \1 body` out. A JSON
// body never holds a raw U+0001, and header names and values never do.
declare const self: Worker;

const waiting = new Map<number, (a: string) => void>();
let next = 1;

self.onmessage = (e: MessageEvent<{ port: number; hostname: string } | string>) => {
  const m = e.data;
  if (typeof m !== "string") {
    Bun.serve({
      port: m.port,
      hostname: m.hostname,
      reusePort: true,
      idleTimeout: 120,
      async fetch(req) {
        const id = next++;
        const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
        let head = `${id}\0${req.method}\0${req.url}`;
        for (const [k, v] of req.headers) head += `\0${k}\0${v}`;
        const answer = new Promise<string>((resolve) => waiting.set(id, resolve));
        self.postMessage(`${head}\u0001${body}`);
        const a = await answer;
        const cut = a.indexOf("\u0001");
        const parts = a.slice(0, cut).split("\0");
        const headers: [string, string][] = [];
        for (let i = 2; i + 1 < parts.length; i += 2) headers.push([parts[i]!, parts[i + 1]!]);
        return new Response(a.slice(cut + 1), { status: Number(parts[1]), headers });
      },
    });
    return;
  }
  const id = Number(m.slice(0, m.indexOf("\0")));
  const resolve = waiting.get(id)!;
  waiting.delete(id);
  resolve(m);
};
