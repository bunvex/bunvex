// The sign-in page's prefill (src/login/prefill.ts): what the serving server wrote into index.html (the image's
// BUNVEX_DEPLOYMENT_URL / BUNVEX_ADMIN_KEY, as Convex's NEXT_PUBLIC_*), else the build's VITE_ values.
import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readPrefill } from "../src/login/prefill.ts";

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});

function page(head: string) {
  const w = new Window({ url: "http://127.0.0.1:6791/" });
  windows.push(w);
  w.document.write(`<!doctype html><html><head>${head}</head><body></body></html>`);
  return w.document as unknown as Document;
}

test("the server's meta tags win over the build's values", () => {
  const doc = page(
    '<meta name="bunvex-deployment-url" content="http://127.0.0.1:3210"><meta name="bunvex-admin-key" content="a|b&amp;c">',
  );
  expect(readPrefill(doc, { deploymentUrl: "http://build", adminKey: "build-key" })).toEqual({
    deploymentUrl: "http://127.0.0.1:3210",
    adminKey: "a|b&c",
  });
});

test("without them, the build's values; empty ones are unset", () => {
  expect(readPrefill(page(""), { deploymentUrl: "http://build", adminKey: "" })).toEqual({
    deploymentUrl: "http://build",
    adminKey: undefined,
  });
  expect(readPrefill(page('<meta name="bunvex-deployment-url" content="">'), {})).toEqual({
    deploymentUrl: undefined,
    adminKey: undefined,
  });
});
