// Ported from centropic-prototype src/lib/ci/code-runs.ts. Keep in step with it.
import type { CodeTestResult, CodeTestStatus } from "./junit";

/**
 * The results of automated tests in the code, as CI uploaded them from the default branch (test_runs). Release
 * readiness judges each linked test by its result in the newest default-branch run that contains it, so a CI setup
 * that uploads unit and end-to-end tests in separate jobs still counts both. Pull-request runs never count here.
 */

/** How many of the newest default-branch runs are read. A linked test missing from all of them counts as not run. */
export const CODE_RUN_WINDOW = 30;

export interface CodeRun {
  id: string;
  commitSha: string;
  ref: string | null;
  /** When it was uploaded. */
  at: string;
  results: CodeTestResult[];
}

export interface CodeTestEvidence {
  path: string;
  name: string;
  status: CodeTestStatus;
  runId: string;
  commitSha: string;
  at: string;
}

/**
 * One entry per test (path and name), from the newest run that contains it. Newest runs' tests come first.
 *
 * A file's newest run is its current set of tests: a test that an older run has but a newer run of the same file
 * doesn't was deleted or renamed, so its old result is dropped instead of counting forever. CI jobs usually split by
 * file (unit, end-to-end), so a test whose whole file is missing from the newest run keeps its older result.
 */
export function latestCodeResults(runs: CodeRun[]): CodeTestEvidence[] {
  const out = new Map<string, CodeTestEvidence>();
  const filesSeen = new Set<string>();
  for (const run of [...runs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) {
    // Within one run, the last result for a test wins (a retried test).
    const inRun = new Map<string, CodeTestResult>();
    for (const r of run.results) inRun.set(`${r.path}\n${r.name}`, r);
    for (const [k, r] of inRun) {
      if (out.has(k) || filesSeen.has(r.path)) continue;
      out.set(k, { path: r.path, name: r.name, status: r.status, runId: run.id, commitSha: run.commitSha, at: run.at });
    }
    for (const r of inRun.values()) filesSeen.add(r.path);
  }
  return [...out.values()];
}

/** The test_runs columns a CodeRun is read from. */
export const CODE_RUN_COLUMNS = "id, commit_sha, ref, created_at, results";

/** test_runs rows (CODE_RUN_COLUMNS) as CodeRuns. Shared by the server's loader and the browser's. */
export function toCodeRuns(rows: unknown): CodeRun[] {
  return ((rows ?? []) as { id: string; commit_sha: string; ref: string | null; created_at: string; results: CodeTestResult[] }[]).map((r) => ({
    id: r.id,
    commitSha: r.commit_sha,
    ref: r.ref,
    at: r.created_at,
    results: Array.isArray(r.results) ? r.results : [],
  }));
}
