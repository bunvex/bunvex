import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({
    seed: 7,
    now: NOW,
    executions: 5,
    documents: { tasks: 6, users: 3, messages: 2, imports: 0 },
    snapshotStepMs: 1,
    ...opts,
  });

function mount(source = mockSource()) {
  render(<Dashboard dataSource={source} history={createMemoryHistory({ initialEntries: ["/settings/snapshots"] })} />);
  return source;
}
const exportSection = () => screen.findByRole("region", { name: "Export" });
const importSection = () => screen.findByRole("region", { name: "Import" });
const count = async (src: MockDataSource, table: string) =>
  (await src.listTables()).find((t) => t.name === table)?.documentCount;

describe("Settings: Snapshots — export", () => {
  test("export with the stored files, see it run, then download the zip", async () => {
    const src = mount();
    const s = await exportSection();
    await within(s).findByText("No snapshot has been exported yet.");
    const user = userEvent.setup();
    await user.click(within(s).getByRole("checkbox", { name: "Include stored files" }));
    await user.click(within(s).getByRole("button", { name: "Export a snapshot" }));
    await within(s).findByText(/Snapshot of tables and stored files/, undefined, { timeout: 3000 });
    const made: Blob[] = [];
    const real = URL.createObjectURL;
    URL.createObjectURL = (b: Blob) => {
      made.push(b);
      return "blob:snapshot";
    };
    try {
      await user.click(within(s).getByRole("button", { name: "Download" }));
      await waitFor(() => expect(made).toHaveLength(1));
    } finally {
      URL.createObjectURL = real;
    }
    expect(made[0]!.type).toBe("application/zip");
    expect(made[0]!.size).toBe((await src.getLatestSnapshotExport())!.size!);
    await expectAccessible();
  });

  test("a credential that may only view: no Export button, no Download", async () => {
    const src = mockSource({ capabilities: { operations: ["viewData", "viewBackups"], readOnly: false } });
    mount(src);
    const s = await exportSection();
    await within(s).findByText("No snapshot has been exported yet.");
    expect(within(s).queryByRole("button", { name: "Export a snapshot" })).toBeNull();
    expect(within(s).queryByRole("button", { name: "Download" })).toBeNull();
  });
});

describe("Settings: Snapshots — import", () => {
  test("a JSON Lines file into a new table: review what changes, import, and it is there", async () => {
    const src = mount();
    const s = await importSection();
    const user = userEvent.setup();
    await user.upload(within(s).getByLabelText("File"), new File(['{"t":"a"}\n{"t":"b"}\n'], "notes.jsonl"));
    expect((within(s).getByRole("radio", { name: "JSON Lines (.jsonl)" }) as HTMLInputElement).checked).toBe(true);
    expect((within(s).getByLabelText("Into the table") as HTMLInputElement).value).toBe("notes");
    expect(within(s).queryByRole("radio", { name: /Replace everything/ })).toBeNull(); // a zip's mode only
    await user.click(within(s).getByRole("button", { name: "Upload and review" }));
    const review = await within(s).findByRole("table");
    expect(within(review).getByRole("rowheader").textContent).toBe("notes");
    expect(
      within(review)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["2", "0"]);
    await expectAccessible();
    await user.click(within(s).getByRole("button", { name: "Import" }));
    await within(s).findByText("Imported 2 documents.", undefined, { timeout: 3000 });
    expect(within(s).getByText("Imported 2 documents into notes")).toBeDefined();
    expect(await count(src, "notes")).toBe(2);
  });

  test("replacing says how much it deletes, on the button too; Cancel leaves everything as it was", async () => {
    const src = mount();
    const s = await importSection();
    const user = userEvent.setup();
    await user.upload(within(s).getByLabelText("File"), new File(['[{"text":"x"}]'], "tasks.json"));
    await user.click(within(s).getByRole("radio", { name: "Replace the documents of the imported tables" }));
    await user.click(within(s).getByRole("button", { name: "Upload and review" }));
    await within(s).findByRole("button", { name: "Import and delete 6 documents" });
    await user.click(within(s).getByRole("button", { name: "Cancel" }));
    await within(s).findByRole("button", { name: "Upload and review" });
    expect(await count(src, "tasks")).toBe(6);
  });

  test("a file that cannot be imported is refused with why, before anything changes", async () => {
    mount();
    const s = await importSection();
    const user = userEvent.setup();
    await user.upload(within(s).getByLabelText("File"), new File(['{"text":"x"}\n'], "tasks.jsonl"));
    await user.click(within(s).getByRole("button", { name: "Upload and review" }));
    expect((await within(s).findByRole("alert")).textContent).toBe(
      'The import failed: tasks already has 6 documents: import with "append" or "replace"',
    );
    await user.click(within(s).getByRole("button", { name: "Import another file" }));
    await within(s).findByRole("button", { name: "Upload and review" });
  });

  test("a read-only credential cannot import, and the page says so", async () => {
    mount(mockSource({ capabilities: { operations: ["viewData", "viewBackups", "importBackups"], readOnly: true } }));
    const s = await importSection();
    await within(s).findByText(/cannot import/);
    expect(within(s).queryByLabelText("File")).toBeNull();
  });

  test("a source without snapshots says the page is not offered", async () => {
    const src = mockSource();
    for (const m of ["getLatestSnapshotExport", "startSnapshotImport"])
      (src as unknown as Record<string, unknown>)[m] = undefined;
    mount(src);
    await screen.findByText("This deployment does not offer snapshots yet.");
  });
});
