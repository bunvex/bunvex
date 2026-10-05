// Package @bunvex/search — full-text search (STUDY-45) and the persisted segments of text and vector indexes
// (STUDY-111).
export { Bm25Weight, FIELDNORMS, fieldnormToId, idf } from "./bm25.ts";
export { NO_FILTER_KEY, SEGMENT_FILE_FORMAT, SegmentFileError } from "./segment-file.ts";
export type { PreparedCompaction, PreparedFlush, SegmentPart, StoredSegment } from "./segmented-index.ts";
export {
  type PreparedTextCompaction,
  type PreparedTextFlush,
  SegmentedTextIndex,
  type TextSegmentPart,
} from "./segmented-text-index.ts";
export {
  compareVectorHits,
  type PreparedVectorCompaction,
  type PreparedVectorFlush,
  SegmentedVectorIndex,
  type VectorFilter,
  type VectorHit,
  type VectorSegmentPart,
} from "./segmented-vector-index.ts";
export {
  type IndexedDoc,
  MAX_CANDIDATE_REVISIONS,
  MAX_QUERY_TERMS,
  MAX_UNIQUE_QUERY_TERMS,
  type TextHit,
  TextIndex,
  type TextQuery,
} from "./text-index.ts";
export { TextSegment, TextSegmentDeletes } from "./text-segment.ts";
export { MAX_TEXT_TERM_LENGTH, tokenize } from "./tokenizer.ts";
export { type VectorDoc, VectorSegment, VectorSegmentDeletes } from "./vector-segment.ts";
