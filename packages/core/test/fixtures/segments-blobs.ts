// Blobs as files in a directory, as the server's local `search` use case keeps them (search segment tests).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SearchSegmentStore } from "../../src/index.ts";

export function fileBlobs(dir: string): SearchSegmentStore {
  mkdirSync(dir, { recursive: true });
  return {
    put: async (d) => {
      const key = crypto.randomUUID();
      await Bun.write(join(dir, key), d);
      return key;
    },
    get: async (k) => {
      const f = Bun.file(join(dir, k));
      return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
    },
    delete: async (k) => rmSync(join(dir, k), { force: true }),
  };
}
