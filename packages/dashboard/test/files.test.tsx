import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatBytes } from "../src/files/screen.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = (over: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 7, now: NOW, executions: 20, documents: { tasks: 5, users: 5 }, ...over });

function mount(path: string, source = mockSource()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return { history, source };
}
const rows = () =>
  within(screen.getByRole("grid", { name: "Files" }))
    .getAllByRole("row")
    .slice(1);
const cells = (r: HTMLElement) =>
  within(r)
    .getAllByRole("gridcell")
    .map((c) => c.textContent ?? "");
const params = (h: ReturnType<typeof createMemoryHistory>) =>
  Object.fromEntries(new URLSearchParams(h.location.search));
const all = async (src: MockDataSource, order: "asc" | "desc" = "desc") =>
  (await src.listFiles({ numItems: 100, cursor: null, order })).page;
const loaded = () => waitFor(() => expect(rows().length).toBeGreaterThan(3));
/** The id column, after the selection checkbox when there is one. */
const idOf = (r: HTMLElement) => cells(r).find((t) => /^[a-z0-9]{32}$/.test(t));

beforeEach(() => localStorage.clear());

test("sizes as people read them", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2.0 KB");
  expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
});

describe("the Files screen", () => {
  test("stored files, newest first, with their size, type and time; the total is said", async () => {
    const { source } = mount("/files");
    await screen.findByRole("heading", { level: 1, name: "Files" });
    await loaded();
    const files = await all(source);
    expect(rows().map(idOf)).toEqual(files.slice(0, rows().length).map((f) => f.id));
    expect(screen.getByText(`${files.length} files stored`)).toBeDefined();
    await expectAccessible();
  });

  test("oldest first, and a day range, in the URL", async () => {
    const { history, source } = mount("/files");
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Order" }));
    await user.click(await screen.findByRole("option", { name: "Oldest first" }));
    await waitFor(() => expect(params(history)).toEqual({ order: "asc" }));
    const oldest = await all(source, "asc");
    await waitFor(() => expect(idOf(rows()[0]!)).toBe(oldest[0]!.id));
    fireEvent.change(screen.getByLabelText("Uploaded until"), { target: { value: "2020-01-01" } });
    fireEvent.blur(screen.getByLabelText("Uploaded until")); // a typed day applies once complete (UX-15)
    await waitFor(() => expect(params(history)).toEqual({ order: "asc", to: "2020-01-01" }));
    await screen.findByText("No file was uploaded in these dates.");
  });

  test("an image's details: a preview, its metadata, Download", async () => {
    const { history, source } = mount("/files");
    await loaded();
    const image = (await all(source)).find((f) => f.contentType === "image/svg+xml")!;
    const user = userEvent.setup();
    const row = rows().find((r) => idOf(r) === image.id)!;
    await user.click(within(row).getAllByRole("gridcell").at(-1)!);
    await waitFor(() => expect(params(history)).toEqual({ file: image.id }));
    const panel = await screen.findByRole("complementary", { name: "File" });
    expect(
      within(panel)
        .getByRole("img", { name: `Preview of ${image.id}` })
        .getAttribute("src"),
    ).toBe(image.url);
    expect(within(panel).getByText(image.sha256)).toBeDefined();
    const download = within(panel).getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(image.url);
    expect(download.hasAttribute("download")).toBe(true);
    await expectAccessible();
  });

  test("a text file has no preview (only images, as Convex)", async () => {
    const source = mockSource();
    const text = (await all(source)).find((f) => f.contentType === "text/plain")!;
    mount(`/files?file=${text.id}`, source);
    const panel = await screen.findByRole("complementary", { name: "File" });
    await within(panel).findByText("text/plain");
    expect(panel.querySelector("img")).toBeNull();
  });

  test("Upload files: stored, said, and listed first", async () => {
    const { source } = mount("/files");
    await loaded();
    const before = (await all(source)).length;
    const file = new File(["hello\n"], "hello.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Files to upload"), { target: { files: [file] } });
    await screen.findByText("Uploaded 1 file.");
    const files = await all(source);
    expect(files.length).toBe(before + 1);
    expect(files[0]!.contentType).toBe("text/plain");
    await waitFor(() => expect(idOf(rows()[0]!)).toBe(files[0]!.id));
    expect(await (await source.files.blob(files[0]!.id))!.text()).toBe("hello\n");
  });

  test("select files and delete them, after a confirmation", async () => {
    const { source } = mount("/files");
    await loaded();
    const user = userEvent.setup();
    const [a, b] = rows();
    const ids = [idOf(a!)!, idOf(b!)!];
    await user.click(within(a!).getByRole("checkbox"));
    await user.click(within(b!).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Delete 2" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete 2 files?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete 2 files" }));
    await screen.findByText("Deleted 2 files.");
    const left = await all(source);
    expect(left.some((f) => ids.includes(f.id))).toBe(false);
    await waitFor(() => expect(rows().some((r) => ids.includes(idOf(r)!))).toBe(false));
  });

  test("look up a file by its storage ID; an unknown one says so", async () => {
    const { history, source } = mount("/files");
    await loaded();
    const target = (await all(source))[5]!;
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Look up by storage ID" }), `${target.id}{Enter}`);
    await waitFor(() => expect(params(history)).toEqual({ file: target.id }));
    const panel = await screen.findByRole("complementary", { name: "File" });
    await within(panel).findByText(target.sha256);
    await user.clear(screen.getByRole("textbox", { name: "Look up by storage ID" }));
    await user.type(screen.getByRole("textbox", { name: "Look up by storage ID" }), "nope{Enter}");
    await within(panel).findByText(/There is no file/);
  });

  test("delete from a file's details", async () => {
    const source = mockSource();
    const target = (await all(source))[0]!;
    const { history } = mount(`/files?file=${target.id}`, source);
    const panel = await screen.findByRole("complementary", { name: "File" });
    const user = userEvent.setup();
    await user.click(await within(panel).findByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete the file" }));
    await screen.findByText("Deleted 1 file.");
    expect(await source.getFile(target.id)).toBeNull();
    await waitFor(() => expect(params(history)).toEqual({}));
  });

  test("a read-only credential browses but cannot upload, select or delete", async () => {
    mount("/files", mockSource({ capabilities: { operations: ["viewData", "writeData"], readOnly: true } }));
    await loaded();
    expect(screen.getByRole("button", { name: /Upload files/ }).hasAttribute("disabled")).toBe(true);
    expect(within(screen.getByRole("grid", { name: "Files" })).queryAllByRole("checkbox")).toEqual([]);
  });

  test("a source without file storage says so", async () => {
    const source = mockSource();
    Object.defineProperty(source, "listFiles", { value: undefined });
    mount("/files", source);
    await screen.findByText("This deployment does not offer file storage yet.");
  });
});
