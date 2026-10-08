// The prerendered HTML must hydrate without a mismatch: the live demo and the tabs render the same first frame
// on the server and in the browser, and only change once mounted (SITE-01 §6).
import { expect, test } from "bun:test";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { Landing } from "../src/components/landing.tsx";

test("hydrates without a mismatch", async () => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Landing />); // the prerender
  document.body.append(container);
  const errors: unknown[] = [];
  const root = await act(async () =>
    hydrateRoot(container, <Landing />, { onRecoverableError: (e) => errors.push(e) }),
  );
  expect(errors).toEqual([]);
  act(() => root.unmount());
  container.remove();
});
