import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { JunitError, parseJunit, type CodeTestResult } from "./core/junit";
import { groundworkKeys, prReport } from "./core/pr-report";
import { isInitialized, matrixOf, readConfig } from "./store/config";
import { load } from "./store/files";

/**
 * `groundwork ci pr`: the pull request report from the repository's own files, as JSON, for the GitHub Action's
 * local mode. The Action gathers the PR's description, commits and changed files from GitHub; this judges them.
 */

export interface PrInput {
  body: string;
  commits: string[];
  /** Changed files, relative to the repository root (as GitHub lists them). */
  changed: string[];
}

/** `report`: the lines are the report, to print as output even when the exit code is 1 for gaps. */
type Out = { code: number; lines: string[]; report?: true };

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });

/**
 * The pull request from git, for CI without a GitHub API to ask (GitLab, Bitbucket, …): the commits on HEAD since
 * `against`, the files changed since they diverged (repository paths), and the project's folder in the repository.
 */
export function prInputFromGit(root: string, against: string, body: string): { input: PrInput; pathPrefix: string } {
  try {
    git(root, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`${root} isn't a git repository, so there's nothing to compare with ${against}.`);
  }
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${against}^{commit}`]);
  } catch {
    throw new Error(
      `${against} isn't in this checkout. In CI, pass origin/<branch> and fetch it first: git fetch origin "+refs/heads/<branch>:refs/remotes/origin/<branch>", with enough history to find where the branches meet.`,
    );
  }
  const commits = git(root, ["log", "--format=%B%x00", `${against}..HEAD`])
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean);
  let changed: string[];
  try {
    // -z: file names exactly as they are, not quoted and escaped.
    changed = git(root, ["diff", "-z", "--name-only", "--no-renames", `${against}...HEAD`]).split("\0").filter(Boolean);
  } catch {
    throw new Error(`Can't find where HEAD and ${against} meet. The checkout's history is too short: fetch more of it (in GitLab, GIT_DEPTH: 0; in Bitbucket, clone depth: full).`);
  }
  return { input: { body, commits, changed }, pathPrefix: git(root, ["rev-parse", "--show-prefix"]).trim() };
}

const isInput = (v: unknown): v is PrInput => {
  const x = v as Partial<PrInput> | null;
  return !!x && typeof x.body === "string" && Array.isArray(x.commits) && Array.isArray(x.changed) && [...x.commits, ...x.changed].every((s) => typeof s === "string");
};

export function runCiPrCommand(
  root: string,
  opts: {
    input: PrInput;
    /** JUnit files with this PR's test results. */
    junit?: string[];
    /** Where files are on GitHub, e.g. https://github.com/acme/app/blob/<sha>/ */
    linkBase?: string;
    /** The project's folder in the repository, e.g. "apps/web/"; empty when groundwork/ is at the root. */
    pathPrefix?: string;
    /** "markdown": only the comment, for a CI log. */
    format?: "json" | "markdown";
    /** Exit 1 when there are gaps, to fail the pipeline. */
    failOnGaps?: boolean;
  },
): Out {
  if (!isInput(opts.input)) return { code: 1, lines: ['The input must be { "body": "…", "commits": ["…"], "changed": ["path"] }.'] };
  // A missing folder (a wrong working-directory, or a PR that deletes groundwork/) must not read as "no gaps".
  if (!isInitialized(root)) return { code: 1, lines: [`No groundwork/config.yml in ${root}. Is working-directory right?`] };
  const prefix = (opts.pathPrefix ?? "").replace(/^\.?\/+/, "").replace(/([^/])$/, "$1/");
  const warnings: string[] = [];
  let results: CodeTestResult[] | undefined;
  if (opts.junit?.length) {
    results = [];
    for (const f of opts.junit) {
      try {
        results.push(...parseJunit(readFileSync(f, "utf8")));
      } catch (e) {
        // A crashed test run can leave a broken report: say so, and judge the rest without test results.
        if (!(e instanceof JunitError)) throw e;
        warnings.push(`${f.split(/[\\/]/).at(-1)}: ${e.message} The test results weren't checked.`);
        results = undefined;
        break;
      }
    }
  }
  const loaded = load(root);
  for (const p of loaded.problems) warnings.push(`${prefix}${p.file.split("\\").join("/")} couldn't be read: ${p.message}`);
  // GitHub lists repository paths; codeRefs are relative to the project. Files outside the project don't count.
  const changed = opts.input.changed.filter((p) => !prefix || p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  // Repository paths, with / on every platform: they're links on GitHub.
  const files = new Map([...loaded.paths].map(([id, path]) => [id, `${prefix}${path.split("\\").join("/")}`]));
  const report = prReport({
    keys: groundworkKeys(opts.input.body, ...opts.input.commits),
    changedPaths: changed,
    items: loaded.items,
    matrix: matrixOf(readConfig(root)),
    files,
    linkBase: opts.linkBase,
    results,
    pathPrefix: prefix,
    notes: warnings,
  });
  const code = opts.failOnGaps && report.gaps.length ? 1 : 0;
  return { code, report: true, lines: [opts.format === "markdown" ? report.markdown : JSON.stringify({ ...report, warnings }, null, 2)] };
}
