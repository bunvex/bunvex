// Each use case has its own place (Convex's `StorageUseCase`): user files and pushed code's modules, so the
// files' orphan sweep never sees a code package (STUDY-35).
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobStoreFromEnv, type LocalBlobStore, s3OptionsFromEnv } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("local: one subdirectory per use case; listing one never shows the other", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-uc-"));
  dirs.push(dir);
  const files = blobStoreFromEnv({ STORAGE_DIR: dir });
  const modules = blobStoreFromEnv({ STORAGE_DIR: dir }, { useCase: "modules" });
  const f = await files.put(new Uint8Array([1]));
  const m = await modules.put(new Uint8Array([2]));
  expect(existsSync(join(dir, "files", `${f.key}.blob`)) && existsSync(join(dir, "modules", `${m.key}.blob`))).toBe(
    true,
  );
  const listed = async (s: LocalBlobStore) => {
    const out: string[] = [];
    for await (const b of s.list()) out.push(b.key);
    return out;
  };
  expect(await listed(files as LocalBlobStore)).toEqual([f.key]);
  expect(await listed(modules as LocalBlobStore)).toEqual([m.key]);
});

test("S3: one bucket per use case, S3_STORAGE_<USE CASE>_BUCKET", () => {
  const env = { S3_STORAGE_FILES_BUCKET: "files-b", S3_STORAGE_MODULES_BUCKET: "modules-b" };
  expect(s3OptionsFromEnv(env)?.bucket).toBe("files-b");
  expect(s3OptionsFromEnv(env, "modules")?.bucket).toBe("modules-b");
  expect(s3OptionsFromEnv({ S3_STORAGE_FILES_BUCKET: "x" }, "modules")).toBeNull();
});
