---
"@bunvex/file-storage": minor
---

S3 uploads ask for server-side encryption (`x-amz-server-side-encryption: AES256`) and CRC32 part checksums, as Convex's, and `AWS_S3_DISABLE_SSE` / `AWS_S3_DISABLE_CHECKSUMS` (`true`) turn them off for S3-compatible stores that refuse them (`disableSse` / `disableChecksums` in `S3Options`). Every write is now a signed multipart upload, as Convex's, with up to 8 parts in flight (STUDY-140).
