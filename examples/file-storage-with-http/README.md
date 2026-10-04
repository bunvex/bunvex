# File storage through HTTP actions

A chat that sends images in one request: the page POSTs the file to an HTTP action, which stores it
(`ctx.storage.store(await request.blob())`) and posts the message; another HTTP action serves it back
(`ctx.storage.get`). Both are routed in `bunvex/http.ts`, on the deployment's site origin, with the CORS
headers a browser on another origin needs, and the preflight (`OPTIONS`) route.

The allowed origin is the deployment's `CLIENT_ORIGIN` variable:

```sh
bun install
bun run dev                                  # starts the local deployment, pushes the functions, opens the page
```

Then, in another terminal in this directory (the deployment exists once `bun run dev` has started it), the origin
Vite serves the page from:

```sh
bunx bunvex env set CLIENT_ORIGIN http://localhost:5173
```

Until it is set, the browser refuses the upload (the preflight has no `Access-Control-Allow-Origin`), and the page
says so.

The functions read it as `process.env.CLIENT_ORIGIN`; typed declarations of a deployment's variables come
with `defineApp`.

Its end-to-end test (`test/e2e.test.ts`) uploads an image through the HTTP action, follows the message live,
reads the same bytes and content type back, and checks the preflight's headers.
