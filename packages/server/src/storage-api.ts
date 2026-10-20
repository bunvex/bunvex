// `ctx.storage` as types (STUDY-32, STUDY-180), as Convex's `StorageReader`, `StorageWriter` and
// `StorageActionWriter` (npm-packages/convex/src/server/storage.ts): a query reads, a mutation also uploads and
// deletes, an action also gets and stores blobs. Types only: the runtime is `FileStorage` (./storage.ts), whose
// objects these describe. Ids are `Id<"_storage">`: Convex's deprecated overloads for plain-string ids (its
// `StorageId`, `FileStorageId`) are not built (DV-543).
import type { GenericId } from "@bunvex/values";

/**
 * A file's metadata, as the deprecated `getMetadata` gives it (Convex's `FileMetadata`, not exported: DV-543).
 * `sha256` is hex, `contentType` null when the upload named none.
 */
type StoredFileMetadata = { storageId: string; sha256: string; size: number; contentType: string | null };

/** `ctx.storage` in a query: a file's URL. */
export interface StorageReader {
  /** The URL a file is served at, or null when there is no such file. */
  getUrl(storageId: GenericId<"_storage">): Promise<string | null>;
  /** @deprecated Read the `_storage` system table instead (`ctx.db.system.get(storageId)`). */
  getMetadata(storageId: GenericId<"_storage">): Promise<StoredFileMetadata | null>;
}

/** `ctx.storage` in a mutation: the reader's, an upload URL, and deleting a file. */
export interface StorageWriter extends StorageReader {
  /** A short-lived URL a client uploads a file to with a POST; the response holds the new file's id. */
  generateUploadUrl(): Promise<string>;
  /** Delete a file: its URL stops serving it. */
  delete(storageId: GenericId<"_storage">): Promise<void>;
}

/** `ctx.storage` in an action: the writer's, getting a file's bytes and storing new ones. */
export interface StorageActionWriter extends StorageWriter {
  /** A file's bytes, or null when there is no such file. */
  get(storageId: GenericId<"_storage">): Promise<Blob | null>;
  /** Store a blob; `sha256` (base64), when given, must match its digest. Resolves to the new file's id. */
  store(blob: Blob, options?: { sha256?: string }): Promise<GenericId<"_storage">>;
}
