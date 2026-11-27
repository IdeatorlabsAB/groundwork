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

type Out = { code: number; lines: string[] };

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
  return { code: 0, lines: [JSON.stringify({ ...report, warnings }, null, 2)] };
}
