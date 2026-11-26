import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { refPath } from "../core/code-refs";
import { CODE_RUN_WINDOW, latestCodeResults, type CodeRun } from "../core/code-runs";
import type { CodeTestResult } from "../core/junit";
import type { Requirement, TestResultStatus, TestResults } from "../core/types";
import { branchesOf, type Config } from "./config";

/**
 * Test results as files in the repository.
 * - CI runs (results/ci/) are committed to the results branch by `groundwork results add --push`, and read from
 *   origin/<resultsBranch> without checking it out (plus the working tree, for a CI job that wrote without pushing).
 * - Test-tool runs (results/tools/) are recorded by the agent in the working tree and committed with ordinary commits.
 * Shapes match the web app's, so a later import carries them across.
 */

export const RESULTS_DIR = "groundwork/results";
const CI_DIR = `${RESULTS_DIR}/ci`;
const TOOLS_DIR = `${RESULTS_DIR}/tools`;

export interface StoredCodeRun extends CodeRun {
  /** "ci" when written in CI; "local" runs (a laptop, a dirty tree) never count as evidence. */
  source: "ci" | "local";
  /** Whether `ref` was the default branch when the run was written. */
  defaultBranch: boolean;
  /** Over the whole report, not just the kept results. */
  totals: { passed: number; failed: number; skipped: number };
}

export interface StoredTestRun {
  source: "test-tool";
  tool: string;
  project: string;
  id: string;
  title: string;
  url?: string;
  /** Product id (PRD-0001) and the version the run tested. */
  product: string;
  version: string;
  results: { id: string; status: TestResultStatus; endTime: string | null }[];
  recordedAt: string;
  recordedBy: string;
  via?: string;
}

export interface LoadedResults {
  codeRuns: StoredCodeRun[];
  testRuns: StoredTestRun[];
  problems: { file: string; message: string }[];
  /** Where results were read from, e.g. ["origin/groundwork-results", "working tree"]. */
  read: string[];
}

const slug = (v: string, max = 40) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "_";

/** 2026-11-27T10:15:00.000Z -> 20261127T101500Z: sorts by time. */
const stamp = (at: string) => new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** results/ci/<time>-<sha7>-<job>.json. `job` tells apart matrix jobs and re-runs on the same commit. */
export const codeRunPath = (run: Pick<CodeRun, "at" | "commitSha">, job: string) => posix.join(CI_DIR, `${stamp(run.at)}-${run.commitSha.slice(0, 7)}-${slug(job, 60)}.json`);

/** results/tools/<tool>-<project>-<run>-<hash>.json: the same run always gets the same file, look-alike ids don't. */
export function testRunPath(run: Pick<StoredTestRun, "tool" | "project" | "id">): string {
  const hash = createHash("sha1").update(`${run.tool.toLowerCase()}\0${run.project.toUpperCase()}\0${run.id}`).digest("hex").slice(0, 8);
  return posix.join(TOOLS_DIR, `${slug(run.tool, 30)}-${slug(run.project || "_")}-${slug(run.id, 60)}-${hash}.json`);
}

/** Every result in a test file that some requirement links a code test in: the file's whole current set of tests. */
export function keepLinked(results: CodeTestResult[], requirements: Pick<Requirement, "codeTests">[]): CodeTestResult[] {
  const files = new Set(requirements.flatMap((r) => (r.codeTests ?? []).map((t) => refPath(t.path))));
  return results.filter((r) => files.has(refPath(r.path)));
}

export function writeResult(root: string, rel: string, data: unknown): string {
  const file = join(root, ...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return rel;
}

function git(root: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, { cwd: root, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

const inRepo = (root: string) => {
  try {
    git(root, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
};

const hasRef = (root: string, ref: string) => {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/** Files under `dir` at `ref`, relative to root (git resolves paths from the working directory, so a subfolder works). */
function filesAt(root: string, ref: string, dir: string): string[] {
  return git(root, ["ls-tree", "-r", "-z", "--name-only", ref, "--", `${dir}/`])
    .toString("utf8")
    .split("\0")
    .filter((p) => p.endsWith(".json"));
}

/** Several blobs in one `git cat-file --batch` call. */
function readAt(root: string, ref: string, paths: string[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (!paths.length) return out;
  const buf = git(root, ["cat-file", "--batch"], paths.map((p) => `${ref}:./${p}`).join("\n") + "\n");
  let at = 0;
  for (const p of paths) {
    const eol = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, eol).toString("utf8");
    const m = /^\S+ blob (\d+)$/.exec(header);
    if (!m) {
      out.set(p, undefined);
      at = eol + 1;
      continue;
    }
    const size = Number(m[1]);
    out.set(p, buf.subarray(eol + 1, eol + 1 + size).toString("utf8"));
    at = eol + 1 + size + 1;
  }
  return out;
}

function workingFiles(root: string, dir: string): string[] {
  const abs = join(root, ...dir.split("/"));
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((n) => n.endsWith(".json"))
    .map((n) => posix.join(dir, n));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function codeRunOf(v: unknown): StoredCodeRun | string {
  if (!isObj(v)) return "not a JSON object";
  for (const k of ["id", "commitSha", "at"] as const) if (typeof v[k] !== "string") return `${k} is missing`;
  if (!Array.isArray(v.results)) return "results is missing";
  if (v.source !== "ci" && v.source !== "local") return 'source must be "ci" or "local"';
  return v as unknown as StoredCodeRun;
}

function testRunOf(v: unknown): StoredTestRun | string {
  if (!isObj(v)) return "not a JSON object";
  if (v.source !== "test-tool") return 'source must be "test-tool"';
  for (const k of ["tool", "id", "title", "product", "version", "recordedAt"] as const) if (typeof v[k] !== "string") return `${k} is missing`;
  if (!Array.isArray(v.results)) return "results is missing";
  return v as unknown as StoredTestRun;
}

/** Every result readable without the network: origin's results branch as last fetched, and the working tree. */
export function loadResults(root: string, config: Config): LoadedResults {
  const { resultsBranch } = branchesOf(config);
  const out: LoadedResults = { codeRuns: [], testRuns: [], problems: [], read: [] };
  const take = <T>(file: string, text: string | undefined, parse: (v: unknown) => T | string, into: T[]) => {
    let v: unknown;
    try {
      v = JSON.parse(text ?? "");
    } catch (e) {
      out.problems.push({ file, message: `isn't a valid result file: ${(e as Error).message}` });
      return;
    }
    const r = parse(v);
    if (typeof r === "string") out.problems.push({ file, message: `isn't a valid result file: ${r}` });
    else into.push(r);
  };

  // CI runs: the branch wins over a working-tree file of the same name; only the newest window is read.
  const ci = new Map<string, { file: string; read: () => string | undefined }>();
  const remote = `refs/remotes/origin/${resultsBranch}`;
  if (inRepo(root) && hasRef(root, remote)) {
    out.read.push(`origin/${resultsBranch}`);
    for (const p of filesAt(root, remote, CI_DIR)) ci.set(posix.basename(p), { file: `${resultsBranch}:${p}`, read: () => undefined });
  }
  out.read.push("working tree");
  for (const p of workingFiles(root, CI_DIR)) {
    const name = posix.basename(p);
    if (!ci.has(name)) ci.set(name, { file: p, read: () => readFileSync(join(root, ...p.split("/")), "utf8") });
  }
  const newest = [...ci.keys()].sort().reverse().slice(0, CODE_RUN_WINDOW);
  const fromBranch = newest.filter((n) => ci.get(n)!.file.startsWith(`${resultsBranch}:`)).map((n) => ci.get(n)!.file.slice(resultsBranch.length + 1));
  const blobs = fromBranch.length ? readAt(root, remote, fromBranch) : new Map<string, string | undefined>();
  for (const n of newest) {
    const e = ci.get(n)!;
    const text = e.file.startsWith(`${resultsBranch}:`) ? blobs.get(e.file.slice(resultsBranch.length + 1)) : e.read();
    take(e.file, text, codeRunOf, out.codeRuns);
  }

  // Test-tool runs live in the working tree, committed with the work they belong to.
  for (const p of workingFiles(root, TOOLS_DIR)) take(p, readFileSync(join(root, ...p.split("/")), "utf8"), testRunOf, out.testRuns);
  return out;
}

/** A product version's test results: its test-tool runs, and code tests' latest results in CI runs on the default branch. */
export function resultsFor(loaded: LoadedResults, product: string, version: string): TestResults {
  const code = loaded.codeRuns.filter((r) => r.source === "ci" && r.defaultBranch);
  const runs = loaded.testRuns.filter((r) => r.product === product && r.version === version);
  return {
    fetchedAt: runs.reduce((latest, r) => (r.recordedAt > latest ? r.recordedAt : latest), ""),
    runs: runs.map(({ tool, project, id, title, url, recordedAt, recordedBy, via }) => ({ tool, project, id, title, ...(url ? { url } : {}), recordedAt, recordedBy, ...(via ? { via } : {}) })),
    results: runs.flatMap((r) => r.results.map((x) => ({ tool: r.tool, project: r.project, id: x.id, runId: r.id, status: x.status, endTime: x.endTime }))),
    code: { runs: code.map(({ id, commitSha, ref, at }) => ({ id, commitSha, ref, at })), results: latestCodeResults(code) },
  };
}
