// The Docker image's entry script (docker/run_backend.sh, STUDY-38): the flags it gives `bunvex-local-backend`
// for the environment, run with a stand-in executable that prints them.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DOCKER = resolve(import.meta.dir, "../../../docker");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** run_backend.sh with `env` (and nothing else of this process's but PATH): the executable's arguments. */
async function entryArgs(env: Record<string, string>): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-entry-"));
  dirs.push(dir);
  for (const f of ["run_backend.sh", "read_credentials.sh"]) copyFileSync(join(DOCKER, f), join(dir, f));
  writeFileSync(join(dir, "bunvex-local-backend"), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  chmodSync(join(dir, "bunvex-local-backend"), 0o755);
  const p = Bun.spawn(["bash", "run_backend.sh"], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DATA_DIR: join(dir, "data"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`run_backend.sh exited ${code}: ${err}`);
  return out.trimEnd().split("\n");
}

const AWS = { AWS_REGION: "us-east-1" };

describe("docker/run_backend.sh", () => {
  test("no bucket: the volume's storage", async () => {
    const args = await entryArgs({});
    expect(args).toContain("--local-storage");
    expect(args).not.toContain("--s3-storage");
  });

  test("any one of Convex's five buckets turns S3 on, for the use cases whose bucket is set (DV-190)", async () => {
    for (const bucket of [
      "S3_STORAGE_FILES_BUCKET",
      "S3_STORAGE_MODULES_BUCKET",
      "S3_STORAGE_EXPORTS_BUCKET",
      "S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET",
      "S3_STORAGE_SEARCH_BUCKET",
    ]) {
      const args = await entryArgs({ ...AWS, [bucket]: "b" });
      expect({ bucket, s3: args.includes("--s3-storage") }).toEqual({ bucket, s3: true });
      expect(args).not.toContain("--local-storage");
    }
  });

  test("an empty bucket variable is unset", async () => {
    expect(await entryArgs({ ...AWS, S3_STORAGE_SEARCH_BUCKET: "" })).not.toContain("--s3-storage");
  });
});
