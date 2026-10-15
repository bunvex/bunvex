import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type App, eventually, startApp } from "./index.ts";

let app: App;
beforeAll(async () => {
  app = await startApp(resolve(import.meta.dir, "../rooms-cursors"));
});
afterAll(() => app?.stop());

test("a cursor moved in one page appears in the other, and a wave too", async () => {
  const one = await app.open();
  const two = await app.open();
  for (const p of [one, two])
    await eventually(async () => (await p.getByTestId("status").innerText()).startsWith("joined"), "the room joined");
  const nameTwo = await two.getByTestId("me").innerText();
  const board = await two.getByTestId("board").boundingBox();
  await two.mouse.move(board!.x + 40, board!.y + 50);
  await two.mouse.move(board!.x + 120, board!.y + 90);
  await eventually(
    async () => (await one.locator(`[data-testid=cursor][data-name="${nameTwo}"]`).count()) === 1,
    "the cursor",
  );
  await two.getByRole("button", { name: "Wave" }).click();
  await eventually(async () => (await one.getByTestId("waves").innerText()).includes(`${nameTwo} waves`), "the wave");
  // A presence scope lists signed-in users: this app has no sign-in, so it says so.
  expect(await one.getByTestId("online").innerText()).toContain("signed-in");
  expect(app.errors).toEqual([]);
});
