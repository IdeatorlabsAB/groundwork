import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import { JunitError, parseJunit, type CodeTestResult } from "../core/junit";
import { branchesOf, readConfig } from "./config";
import { load } from "./files";
import { codeRunPath, keepLinked, writeResult, type StoredCodeRun } from "./results";

type Env = Record<string, string | undefined>;

export interface ResultsOptions {
  /** JUnit files or globs, resolved from the working directory. */
  files: string[];
  commit?: string;
  ref?: string;
  push?: boolean;
  /** When the run happened; now by default. For tests. */
  at?: string;
  /** Defaults to process.env. */
  env?: Env;
  /** Called before each push attempt. For tests. */
  beforePush?: () => void;
}

class PushError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const childEnv = (env: Env): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete out[k];
  else out[k] = v;
  return out;
};

function run(cwd: string, env: Env, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, input, env: childEnv(env), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** git's reason: what the server said (remote: lines, e.g. a ruleset's GH013), else git's first fatal or error line, without a final period. */
function stderrOf(e: unknown): string {
  const lines = String((e as { stderr?: unknown }).stderr ?? (e as Error).message)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const remote = lines.filter((l) => l.startsWith("remote:")).map((l) => l.replace(/^remote:\s*/, "")).filter(Boolean);
  const fatal = lines.find((l) => /^(fatal|error):/.test(l));
  return (remote.length ? remote.join(" ") : (fatal ?? lines.at(-1) ?? "unknown error")).replace(/\.+$/, "");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Commit one result file to the results branch and push it, without touching the checked-out branch or the working
 * tree: a temporary index on top of origin's branch tip. A rejected push (another job got there first) is redone on
 * the new tip; any other failure stops at once.
 */
export async function pushResult(
  root: string,
  rel: string,
  json: string,
  opts: { branch: string; message: string; env?: Env; attempts?: number; beforePush?: () => void },
): Promise<{ attempts: number }> {
  const env = opts.env ?? process.env;
  const prefix = run(root, env, ["rev-parse", "--show-prefix"]);
  const remoteRef = `refs/remotes/origin/${opts.branch}`;
  const identity: Env = {
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? "groundwork",
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? "groundwork@localhost",
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME ?? env.GIT_AUTHOR_NAME ?? "groundwork",
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL ?? env.GIT_AUTHOR_EMAIL ?? "groundwork@localhost",
  };
  const max = opts.attempts ?? 5;
  for (let attempt = 1; ; attempt++) {
    // Does the remote have the branch yet? Exit 2 means no; anything else non-zero is a real failure.
    let exists: boolean;
    try {
      run(root, env, ["ls-remote", "--exit-code", "origin", `refs/heads/${opts.branch}`]);
      exists = true;
    } catch (e) {
      if ((e as { status?: number }).status !== 2) throw new PushError(stderrOf(e));
      exists = false;
    }
    if (exists) {
      // An explicit refspec: a single-branch clone's default refspec wouldn't create origin/<branch>.
      try {
        run(root, env, ["fetch", "-q", "--depth=1", "origin", `+refs/heads/${opts.branch}:${remoteRef}`]);
      } catch (e) {
        throw new PushError(stderrOf(e));
      }
    }
    const tmp = mkdtempSync(join(tmpdir(), "groundwork-index-"));
    let commit: string;
    try {
      const idx: Env = { ...env, GIT_INDEX_FILE: resolve(tmp, "index") };
      run(root, idx, exists ? ["read-tree", remoteRef] : ["read-tree", "--empty"]);
      const blob = run(root, idx, ["hash-object", "-w", "--stdin"], json);
      run(root, idx, ["update-index", "--add", "--cacheinfo", `100644,${blob},${prefix}${rel}`]);
      const tree = run(root, idx, ["write-tree"]);
      commit = run(root, { ...env, ...identity }, ["commit-tree", tree, ...(exists ? ["-p", remoteRef] : []), "-m", opts.message]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    opts.beforePush?.();
    try {
      run(root, env, ["push", "-q", "origin", `${commit}:refs/heads/${opts.branch}`]);
      return { attempts: attempt };
    } catch (e) {
      const msg = String((e as { stderr?: unknown }).stderr ?? "");
      // Only losing a race with another job is worth redoing. A server that declined the push (a ruleset, a hook) won't change its mind.
      const declined = /\[remote rejected\]|declined/i.test(msg);
      const raced = !declined && /fetch first|non-fast-forward|failed to update ref|cannot lock ref/i.test(msg);
      if (!raced || attempt >= max) throw new PushError(stderrOf(e));
      await sleep(200 + Math.random() * 800);
    }
  }
}

const gitOr = (cwd: string, env: Env, args: string[]): string | undefined => {
  try {
    return run(cwd, env, args) || undefined;
  } catch {
    return undefined;
  }
};

/** The repository's default branch: from the GitHub event file when there is one, else config.yml. */
function defaultBranchOf(env: Env, configured: string): string {
  const event = env.GITHUB_EVENT_PATH;
  if (event && existsSync(event)) {
    try {
      const b = (JSON.parse(readFileSync(event, "utf8")) as { repository?: { default_branch?: unknown } }).repository?.default_branch;
      if (typeof b === "string" && b) return b;
    } catch {
      // Fall back to config.yml.
    }
  }
  return configured;
}

const branchOf = (ref: string | null) => (ref ? ref.replace(/^refs\/heads\//, "") : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `groundwork results add <junit>… [--push]`: one CI run's results, for the tests requirements link to. */
export async function runResultsCommand(root: string, cwd: string, opts: ResultsOptions): Promise<{ code: number; lines: string[] }> {
  const env = opts.env ?? process.env;
  const lines: string[] = [];
  const files = [...new Set(opts.files.flatMap((p) => (existsSync(resolve(cwd, p)) ? [p] : globSync(p, { cwd }))))].map((f) => resolve(cwd, f));
  if (!files.length) return { code: 1, lines: [`No JUnit files match ${opts.files.join(", ")}.`] };
  const all: CodeTestResult[] = [];
  for (const f of files) {
    try {
      all.push(...parseJunit(readFileSync(f, "utf8")));
    } catch (e) {
      if (e instanceof JunitError) return { code: 1, lines: [`${relative(cwd, f).split(sep).join("/")}: ${e.message}`] };
      throw e;
    }
  }
  const config = readConfig(root);
  const { resultsBranch, defaultBranch } = branchesOf(config);
  const kept = keepLinked(all, load(root).items.requirements);
  const ref = opts.ref ?? env.GITHUB_REF ?? gitOr(root, env, ["symbolic-ref", "-q", "HEAD"]) ?? null;
  const commitSha = opts.commit ?? env.GITHUB_SHA ?? gitOr(root, env, ["rev-parse", "HEAD"]) ?? "0000000";
  // CI=false or CI=0 means not in CI, whatever a tool exported it for.
  const source = env.CI && !/^(false|0)$/i.test(env.CI) ? "ci" : "local";
  const runData: StoredCodeRun = {
    id: randomUUID(),
    commitSha,
    ref,
    at: opts.at ?? new Date().toISOString(),
    source,
    defaultBranch: branchOf(ref) === defaultBranchOf(env, defaultBranch),
    totals: {
      passed: all.filter((r) => r.status === "passed").length,
      failed: all.filter((r) => r.status === "failed").length,
      skipped: all.filter((r) => r.status === "skipped").length,
    },
    results: kept,
  };
  // Matrix legs share run id, attempt and job name, so a random part keeps two runs in the same second apart.
  const random = randomBytes(3).toString("hex");
  const job = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}-${env.GITHUB_JOB ?? "job"}-${random}` : random;
  const rel = codeRunPath(runData, job);
  const linkedFiles = new Set(kept.map((r) => r.path)).size;
  const what = `${plural(kept.length, "result")} from ${plural(linkedFiles, "linked test file")} (${all.length} in the reports).`;
  lines.push(opts.push ? `Recorded ${rel} on ${resultsBranch}: ${what}` : `Wrote ${rel}: ${what}`);
  if (source === "local") lines.push("Not in CI: this run won't count as evidence.");
  if (!opts.push) {
    writeResult(root, rel, runData);
    return { code: 0, lines };
  }
  if (!gitOr(root, env, ["rev-parse", "--git-dir"])) {
    lines.push("--push needs a git repository with an origin remote; this folder isn't in one.");
    return { code: 1, lines };
  }
  try {
    await pushResult(root, posix.normalize(rel), `${JSON.stringify(runData, null, 2)}\n`, { branch: resultsBranch, message: `Groundwork results: ${rel}`, env, beforePush: opts.beforePush });
  } catch (e) {
    if (!(e instanceof PushError)) throw e;
    lines.push(`Couldn't push results to ${resultsBranch}: ${e.message}. In GitHub Actions the job needs permissions: contents: write, and a ruleset that covers every branch must allow ${resultsBranch}.`);
    return { code: 1, lines };
  }
  lines.push(`Pushed to ${resultsBranch}.`);
  return { code: 0, lines };
}
