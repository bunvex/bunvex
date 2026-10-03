// The push's index and schema checks (STUDY-56), as Convex's CLI (cli/lib/checkForLargeIndexDeletion.ts,
// checkForLargeIndexBackfill.ts, checkForSlowSchemaValidation.ts): before `start_push`, one
// `evaluate_schema` call tells what the push would do. Deleting an index of a large table, or creating
// (or enabling) a non-staged one that blocks the push for its backfill, asks for confirmation — or needs
// `--skip-large-indexes-check` without a terminal; a dry run warns about a slow schema walk.
import type { Io } from "./io.ts";

export type CheckMode = "no verification" | "ask for confirmation" | "has confirmation";

type IndexPrediction = {
  name: string;
  type: "database" | "search" | "vector";
  fields?: string[];
  searchField?: string;
  vectorField?: string;
  dimensions?: number;
  filterFields?: string[];
  staged: boolean;
  change: "added" | "identical" | "enabled" | "disabled" | "dropped";
  needsBackfill: boolean;
  numDocs: number;
};
type TablePrediction = { name: string; outcome: string; numDocs: number; sizeBytes: number };
export type SchemaEvaluation = {
  componentSchemaEvaluations: Record<string, { tables: TablePrediction[]; indexes: IndexPrediction[] }>;
};

/** Stops the push: the message was printed already. */
export class PushCanceled extends Error {}

const intFromEnv = (io: Io, name: string, fallback: number) => {
  const v = io.env[name];
  const n = v === undefined ? Number.NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Convex's thresholds (`MIN_DOCUMENTS_FOR_INDEX_*_WARNING`, `MIN_BYTES_FOR_SCHEMA_WALK_WARNING`). */
const minDocsDelete = (io: Io) => intFromEnv(io, "BUNVEX_MIN_DOCUMENTS_FOR_INDEX_DELETE_WARNING", 100_000);
const minDocsBackfill = (io: Io) => intFromEnv(io, "BUNVEX_MIN_DOCUMENTS_FOR_INDEX_BACKFILL_WARNING", 100_000);
const minBytesWalk = (io: Io) => intFromEnv(io, "BUNVEX_MIN_BYTES_FOR_SCHEMA_WALK_WARNING", 1 << 27);

const filterFields = (f: string[] = []) =>
  f.length === 0 ? "" : `, filter${f.length === 1 ? "" : "s"} on ${f.join(", ")}`;

/** An index as Convex's `formatIndex`: `table.index`, its fields, `(staged)`. */
export function formatIndex(i: IndexPrediction): string {
  const fields =
    i.type === "database"
      ? `  ${(i.fields ?? []).join(", ")}`
      : i.type === "search"
        ? `(text)   ${i.searchField}${filterFields(i.filterFields)}`
        : `(vector)   ${i.vectorField} (${i.dimensions} dimensions)${filterFields(i.filterFields)}`;
  return `${i.name} ${fields}${i.staged ? "  (staged)" : ""}`;
}

const BYTE_UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB", "PiB"];
/** Convex's `formatSize`. */
export function formatSize(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (Number(value.toFixed(1)) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1).replace(/\.0$/, "")} ${BYTE_UNITS[unit]}`;
}

const NON_INTERACTIVE = `To confirm the push:
• run the deploy command in an interactive terminal
• or run the deploy command with the --skip-large-indexes-check flag`;

/** Convex's `promptYesNo` (default no); without a terminal, the push stops with `nonInteractive`. */
function confirm(io: Io, message: string): void {
  if (!io.prompt) {
    io.err(NON_INTERACTIVE);
    throw new PushCanceled(NON_INTERACTIVE);
  }
  const answer = (io.prompt(`? ${message} (y/N)`) ?? "").trim();
  if (!/^(y|yes)$/i.test(answer)) {
    io.err("Canceling push");
    throw new PushCanceled("Canceling push");
  }
  io.err("✔ Proceeding with push.");
}

const entries = (e: SchemaEvaluation) =>
  Object.entries(e.componentSchemaEvaluations).flatMap(([path, p]) => p.indexes.map((index) => ({ path, index, p })));

/** Convex's `checkForLargeIndexDeletion`. */
export function checkLargeIndexDeletion(io: Io, e: SchemaEvaluation, mode: CheckMode, url: string) {
  if (mode === "no verification") return;
  const deleted = entries(e)
    .filter(({ index }) => index.change === "dropped")
    .map(({ path, index, p }) => ({
      path,
      index,
      replacedBy: p.indexes.find((o) => o.change === "added" && o.name === index.name) ?? null,
    }));
  if (deleted.length === 0) {
    io.err("✔ No indexes are deleted by this push");
    return;
  }
  const min = minDocsDelete(io);
  if (!deleted.some(({ index }) => index.numDocs >= min)) {
    io.err("✔ No large indexes are deleted by this push");
    return;
  }
  const lines = deleted.map(({ path, index, replacedBy }) => {
    const n = index.numDocs;
    const count =
      n >= min
        ? `  ⚠️  ${n.toLocaleString()} documents`
        : `  ${n.toLocaleString()} ${n === 1 ? "document" : "documents"}`;
    const replaced = replacedBy ? `\n   → replaced by: ${formatIndex(replacedBy)}` : "";
    return `⛔ ${path ? `${path}:` : ""}${formatIndex(index)}${count}${replaced}`;
  });
  io.err(`⚠️  This code push will delete the following ${deleted.length === 1 ? "index" : "indexes"}
from your production deployment (${url}):

${lines.join("\n")}

The documents that are in the index won’t be deleted, but the index will need
to be backfilled again if you want to restore it later.
`);
  if (mode === "has confirmation") {
    io.err("✔ Proceeding with push since deleting large indexes was allowed by flag");
    return;
  }
  confirm(io, `Delete ${deleted.length === 1 ? "this index" : "these indexes"}?`);
}

/** Convex's `checkForLargeIndexBackfill`; `warn` (a dry run) reports without asking. */
export function checkLargeIndexBackfill(io: Io, e: SchemaEvaluation, mode: CheckMode | "warn", url: string) {
  if (mode === "no verification") return;
  const min = minDocsBackfill(io);
  const blocking = entries(e).filter(
    ({ index }) =>
      index.needsBackfill &&
      !index.staged &&
      (index.change === "added" || index.change === "enabled") &&
      index.numDocs >= min,
  );
  if (blocking.length === 0) return;
  const plural = blocking.length !== 1;
  const lines = blocking.map(({ path, index }) => {
    const enabled = index.change === "enabled" ? "\n   enabled before its staged backfill finished" : "";
    return `⛔ ${path ? `${path}:` : ""}${formatIndex(index)}  ⚠️  ${index.numDocs.toLocaleString()} documents${enabled}`;
  });
  io.err(`⚠️  This push will create the following ${plural ? "indexes on large tables" : "index on a large table"}
in your deployment (${url}). The deploy will block until ${plural ? "they finish" : "it finishes"} backfilling:

${lines.join("\n")}

Tip: stage the index (e.g. \`.index("by_field", { fields: ["field"], staged: true })\`) to backfill
it in the background without blocking the deploy, then remove \`staged\` in a later push once it’s ready.
`);
  if (mode === "warn") return;
  if (mode === "has confirmation") {
    io.err("✔ Proceeding with push since --skip-large-indexes-check is set");
    return;
  }
  confirm(io, `Create ${plural ? "these indexes" : "this index"} now?`);
}

/** Convex's `checkForSlowSchemaValidation` (dry runs): the tables the push would walk, past 128 MiB. */
export function checkSlowSchemaValidation(io: Io, e: SchemaEvaluation) {
  const walked = Object.entries(e.componentSchemaEvaluations).flatMap(([path, p]) =>
    p.tables.filter((t) => t.outcome === "mustWalk").map((table) => ({ path, table })),
  );
  if (walked.length === 0) return;
  const total = walked.reduce((n, { table }) => n + table.sizeBytes, 0);
  if (total < minBytesWalk(io)) return;
  const lines = walked.map(
    ({ path, table }) =>
      `  ${path ? `${path}: ` : ""}${table.name} (${table.numDocs.toLocaleString()} documents, ${formatSize(table.sizeBytes)})`,
  );
  io.err(`⚠️  This schema change requires checking every document in the following ${walked.length === 1 ? "table" : "tables"} against your new schema, totaling ${formatSize(total)}. This deploy may take a while:

${lines.join("\n")}
`);
}

/** Convex's `getDefaultDeployMessage`: on a known CI platform, its name and the commit. */
export function defaultDeployMessage(env: Record<string, string | undefined>): string | null {
  const platforms: { name: string; detect: () => boolean; sha: string }[] = [
    { name: "GitHub Actions", detect: () => !!env.GITHUB_ACTIONS, sha: "GITHUB_SHA" },
    { name: "Vercel", detect: () => !!env.VERCEL, sha: "VERCEL_GIT_COMMIT_SHA" },
    { name: "Netlify", detect: () => !!env.NETLIFY, sha: "COMMIT_REF" },
    { name: "Cloudflare Pages", detect: () => !!env.CF_PAGES, sha: "CF_PAGES_COMMIT_SHA" },
    { name: "Cloudflare Workers", detect: () => !!env.WORKERS_CI, sha: "WORKERS_CI_COMMIT_SHA" },
    { name: "Render", detect: () => !!env.RENDER, sha: "RENDER_GIT_COMMIT" },
    { name: "Railway", detect: () => !!env.RAILWAY_ENVIRONMENT, sha: "RAILWAY_GIT_COMMIT_SHA" },
    { name: "GitLab CI", detect: () => !!env.GITLAB_CI, sha: "CI_COMMIT_SHA" },
    { name: "CircleCI", detect: () => !!env.CIRCLECI, sha: "CIRCLE_SHA1" },
    {
      name: "Google Cloud Build",
      detect: () => !!env.BUILD_ID && !!env.PROJECT_ID && !!env.PROJECT_NUMBER && !!env.LOCATION,
      sha: "SHORT_SHA",
    },
    { name: "Heroku", detect: () => !!env.HEROKU_APP_NAME || !!env.DYNO, sha: "HEROKU_BUILD_COMMIT" },
  ];
  const p = platforms.find((x) => x.detect());
  if (!p) return null;
  const sha = env[p.sha];
  return sha ? `Deployed from ${p.name} • ${sha.slice(0, 7)}` : `Deployed from ${p.name}`;
}
