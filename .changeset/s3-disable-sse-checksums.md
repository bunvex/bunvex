---
"@bunvex/file-storage": minor
---

S3 uploads ask for server-side encryption (`x-amz-server-side-encryption: AES256`) and CRC32 part checksums, as Convex's, and `AWS_S3_DISABLE_SSE` / `AWS_S3_DISABLE_CHECKSUMS` (`true`) turn them off for S3-compatible stores that refuse them (`disableSse` / `disableChecksums` in `S3Options`). Every write is now a signed multipart upload, as Convex's, cut into parts as Convex's (5 MiB doubling up to `STORAGE_MAX_INTERMEDIATE_PART_SIZE`, 200 MiB; the remaining buffer, even empty, as the last part) with up to 8 in flight (STUDY-140). `S3Options.partSize` is replaced by `minPartSize` / `maxPartSize`.
