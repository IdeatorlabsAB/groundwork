import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../src/store/config";
import { renderItem } from "../src/store/files";
import { loadResults } from "../src/store/results";
import { runResultsCommand } from "../src/store/results-cli";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const JUNIT = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="a" file="test/a.test.ts">
    <testcase classname="test/a.test.ts" name="a &gt; REQ-0002 works" file="test/a.test.ts"/>
    <testcase classname="test/a.test.ts" name="a &gt; other" file="test/a.test.ts"><failure message="x"/></testcase>
  </testsuite>
  <testsuite name="b" file="test/b.test.ts">
    <testcase classname="test/b.test.ts" name="b unlinked" file="test/b.test.ts"/>
  </testsuite>
</testsuites>`;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * A bare origin with a project on main (optionally in a subfolder), and a CI checkout of it: a shallow,
 * single-branch clone, as actions/checkout makes.
 */
function setup(opts: { sub?: string; linked?: boolean } = {}) {
  const top = mkdtempSync(join(tmpdir(), "gw-results-cli-"));
  dirs.push(top);
  const origin = join(top, "origin.git");
  const seed = join(top, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "user.email", "seed@example.com");
  const project = join(seed, opts.sub ?? "");
  mkdirSync(project, { recursive: true });
  writeConfig(project, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [] });
  const req = renderItem({
    id: "REQ-0002",
    title: "Works",
    kind: "solution",
    story: "The app shall work.",
    acceptanceCriteria: ["Works"],
    status: "approved",
    stakeholderIds: ["REQ-0001"],
    findingIds: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    ...(opts.linked === false ? {} : { codeTests: [{ path: "test/a.test.ts", name: "a > REQ-0002 works", linkedAt: "x", linkedBy: "sam" }] }),
  });
  mkdirSync(join(project, "groundwork/requirements"), { recursive: true });
  writeFileSync(join(project, "groundwork/requirements/REQ-0002-works.md"), req);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "base");
  git(seed, "push", "-q", origin, "main");
  const ci = join(top, "ci");
  execFileSync("git", ["clone", "-q", "--depth", "1", "--single-branch", "--branch", "main", `file://${origin}`, ci]);
  const root = join(ci, opts.sub ?? "");
  const report = join(root, "reports", "junit.xml");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JUNIT);
  const sha = git(ci, "rev-parse", "HEAD").trim();
  const env = { CI: "true", GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "4521", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "test", GIT_AUTHOR_NAME: undefined, HOME: process.env.HOME };
  return { top, origin, ci, root, sha, env };
}

const branchFiles = (origin: string, branch = "groundwork-results") => git(origin, "ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean);
const run = (s: ReturnType<typeof setup>, opts: Partial<Parameters<typeof runResultsCommand>[2]> = {}) =>
  runResultsCommand(s.root, s.root, { files: ["reports/*.xml"], env: s.env, at: "2026-11-27T10:15:00.000Z", ...opts });

describe("groundwork results add", () => {
  it("keeps the results of linked files, and writes a run with none", async () => {
    const s = setup();
    const out = await run(s);
    expect(out.code).toBe(0);
    const file = readdirSync(join(s.root, "groundwork/results/ci"))[0];
    const data = JSON.parse(readFileSync(join(s.root, "groundwork/results/ci", file), "utf8"));
    expect(data).toMatchObject({ source: "ci", defaultBranch: true, ref: "refs/heads/main", commitSha: s.sha, totals: { passed: 2, failed: 1, skipped: 0 } });
    expect(data.results.map((r: { name: string }) => r.name)).toEqual(["a > REQ-0002 works", "a > other"]);
    expect(out.lines[0]).toBe(`Wrote groundwork/results/ci/${file}: 2 results from 1 linked test file (3 in the reports).`);

    const none = setup({ linked: false });
    await run(none);
    const empty = JSON.parse(readFileSync(join(none.root, "groundwork/results/ci", readdirSync(join(none.root, "groundwork/results/ci"))[0]), "utf8"));
    expect(empty.results).toEqual([]);
    expect(empty.totals).toEqual({ passed: 2, failed: 1, skipped: 0 });
  });

  it("marks a run outside CI as local", async () => {
    const s = setup();
    const out = await run(s, { env: { ...s.env, CI: undefined } });
    expect(out.lines).toContain("Not in CI: this run won't count as evidence.");
    const file = readdirSync(join(s.root, "groundwork/results/ci"))[0];
    expect(JSON.parse(readFileSync(join(s.root, "groundwork/results/ci", file), "utf8")).source).toBe("local");
  });

  it("reads commit and ref from GITHUB_SHA and GITHUB_REF, and the default branch from the event file", async () => {
    const s = setup();
    const event = join(s.top, "event.json");
    writeFileSync(event, JSON.stringify({ repository: { default_branch: "trunk" } }));
    await run(s, { env: { ...s.env, GITHUB_SHA: "1234567890abcdef", GITHUB_REF: "refs/heads/feature", GITHUB_EVENT_PATH: event } });
    const name = readdirSync(join(s.root, "groundwork/results/ci"))[0];
    expect(name).toMatch(/^20261127T101500Z-1234567-4521-1-test-[0-9a-f]{6}\.json$/);
    const data = JSON.parse(readFileSync(join(s.root, "groundwork/results/ci", name), "utf8"));
    expect(data).toMatchObject({ commitSha: "1234567890abcdef", ref: "refs/heads/feature", defaultBranch: false });
  });

  it("fails clearly when no JUnit file matches", async () => {
    const s = setup();
    const out = await run(s, { files: ["nothing/*.xml"] });
    expect(out).toEqual({ code: 1, lines: ["No JUnit files match nothing/*.xml."] });
  });
});

describe("groundwork results add --push", () => {
  it("--push creates the results branch on a remote that doesn't have it", async () => {
    const s = setup();
    const before = git(s.ci, "rev-parse", "HEAD");
    const out = await run(s, { push: true });
    expect(out.code).toBe(0);
    expect(out.lines).toContain("Pushed to groundwork-results.");
    expect(branchFiles(s.origin)).toEqual([expect.stringMatching(new RegExp(`^groundwork/results/ci/20261127T101500Z-${s.sha.slice(0, 7)}-4521-1-test-[0-9a-f]{6}\\.json$`))]);
    expect(git(s.ci, "rev-parse", "HEAD")).toBe(before);
    expect(git(s.ci, "branch", "--show-current").trim()).toBe("main");
    // The push doesn't also leave the file in the working tree, where a later `git add -A` could commit it to main.
    expect(git(s.ci, "status", "--porcelain", "--untracked-files=all").split("\n").filter((l) => l.includes("groundwork/results"))).toEqual([]);
  });

  it("--push adds to an existing results branch from a single-branch shallow clone", async () => {
    const s = setup();
    await run(s, { push: true });
    const second = setup();
    // A fresh CI checkout of the same origin: it has never seen the results branch.
    rmSync(second.ci, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", "--depth", "1", "--single-branch", "--branch", "main", `file://${s.origin}`, second.ci]);
    mkdirSync(join(second.ci, "reports"), { recursive: true });
    writeFileSync(join(second.ci, "reports", "junit.xml"), JUNIT);
    const out = await runResultsCommand(second.ci, second.ci, { files: ["reports/*.xml"], env: { ...s.env, GITHUB_RUN_ID: "4522" }, at: "2026-11-27T11:00:00.000Z", push: true });
    expect(out.code).toBe(0);
    expect(branchFiles(s.origin)).toHaveLength(2);
  });

  it("--push and the readers agree when groundwork/ is in a subfolder", async () => {
    const s = setup({ sub: "apps/web" });
    await run(s, { push: true });
    expect(branchFiles(s.origin)[0]).toMatch(/^apps\/web\/groundwork\/results\/ci\//);
    git(s.ci, "fetch", "-q", "origin", "+refs/heads/groundwork-results:refs/remotes/origin/groundwork-results");
    expect(loadResults(s.root, readConfig(s.root)).codeRuns).toHaveLength(1);
  });

  it("--push works without a git identity", async () => {
    const s = setup();
    const home = mkdtempSync(join(tmpdir(), "gw-home-"));
    dirs.push(home);
    const out = await run(s, { push: true, env: { ...s.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: home } });
    expect(out.code).toBe(0);
    expect(git(s.origin, "log", "-1", "--format=%an <%ae>", "groundwork-results").trim()).toBe("groundwork <groundwork@localhost>");
  });

  it("--push retries on top of a concurrent push", async () => {
    const s = setup();
    let raced = false;
    const out = await run(s, {
      push: true,
      beforePush: () => {
        if (raced) return;
        raced = true;
        // Another job pushes its own results first.
        const other = join(s.top, "other");
        execFileSync("git", ["clone", "-q", `file://${s.origin}`, other]);
        git(other, "config", "user.name", "Other");
        git(other, "config", "user.email", "other@example.com");
        git(other, "checkout", "-q", "--orphan", "groundwork-results");
        git(other, "rm", "-rqf", "--cached", ".");
        mkdirSync(join(other, "groundwork/results/ci"), { recursive: true });
        writeFileSync(join(other, "groundwork/results/ci/20261127T101400Z-0000000-other.json"), "{}");
        git(other, "add", "groundwork/results/ci");
        git(other, "commit", "-q", "-m", "other");
        git(other, "push", "-q", "origin", "groundwork-results");
      },
    });
    expect(out.code).toBe(0);
    expect(branchFiles(s.origin)).toHaveLength(2);
  });

  it("two matrix legs on the same commit in the same second keep both runs", async () => {
    const s = setup();
    await run(s, { push: true });
    await run(s, { push: true });
    expect(branchFiles(s.origin)).toHaveLength(2);
  });

  it("a push a branch rule declines isn't retried, and says why", async () => {
    const s = setup();
    const hook = join(s.origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'GH013: Repository rule violations found for refs/heads/groundwork-results.' >&2\nexit 1\n", { mode: 0o755 });
    let attempts = 0;
    const out = await run(s, { push: true, beforePush: () => void attempts++ });
    expect(out.code).toBe(1);
    expect(attempts).toBe(1);
    expect(out.lines.at(-1)).toContain("GH013: Repository rule violations found");
    expect(out.lines.at(-1)).toContain("ruleset");
    expect(out.lines.at(-1)).not.toMatch(/\.\./);
  });

  it("--push doesn't retry an auth failure", async () => {
    const s = setup();
    git(s.ci, "remote", "set-url", "origin", join(s.top, "no-such-remote.git"));
    let attempts = 0;
    const out = await run(s, { push: true, beforePush: () => void attempts++ });
    expect(out.code).toBe(1);
    expect(attempts).toBeLessThanOrEqual(1);
    expect(out.lines.at(-1)).toMatch(/^Couldn't push results to groundwork-results: fatal: .+\. In GitHub Actions the job needs permissions: contents: write, and a ruleset that covers every branch must allow groundwork-results\.$/);
  });
});

describe("results add, polished", () => {
  it("--push says where it recorded the run, not that it wrote a file", async () => {
    const s = setup();
    const out = await run(s, { push: true });
    expect(out.lines[0]).toMatch(/^Recorded groundwork\/results\/ci\/.+\.json on groundwork-results: 2 results from 1 linked test file \(3 in the reports\)\.$/);
  });

  it("--push outside a git repository says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-nogit-push-"));
    dirs.push(dir);
    writeConfig(dir, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [] });
    writeFileSync(join(dir, "junit.xml"), JUNIT);
    const out = await runResultsCommand(dir, dir, { files: ["junit.xml"], env: { CI: "true" }, push: true });
    expect(out).toEqual({ code: 1, lines: expect.arrayContaining(["--push needs a git repository with an origin remote; this folder isn't in one."]) });
  });

  it("CI=false isn't CI", async () => {
    const s = setup();
    await run(s, { env: { ...s.env, CI: "false" } });
    const file = readdirSync(join(s.root, "groundwork/results/ci"))[0];
    expect(JSON.parse(readFileSync(join(s.root, "groundwork/results/ci", file), "utf8")).source).toBe("local");
  });
});

describe("fetching results before a sign-off", () => {
  it("a repository without an origin gets no fetch warning", async () => {
    const { fetchResults } = await import("../src/store/signing");
    const dir = mkdtempSync(join(tmpdir(), "gw-noorigin-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    writeConfig(dir, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [] });
    expect(fetchResults(dir, readConfig(dir))).toEqual({ fetched: false, commit: null });
  });
});

describe("results add --push, after the review", () => {
  it("says it recorded the run only once the push worked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-noorigin-push-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    writeConfig(dir, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [] });
    writeFileSync(join(dir, "junit.xml"), JUNIT);
    const out = await runResultsCommand(dir, dir, { files: ["junit.xml"], env: { CI: "true" }, push: true });
    expect(out.code).toBe(1);
    expect(out.lines.join("\n")).not.toContain("Recorded");
    expect(out.lines).toContain("--push needs a git repository with an origin remote; this folder isn't in one.");
  });
});

/** GitLab and Bitbucket check out the commit, not the branch, and name the branch and commit in their own variables. */
describe("results add on GitLab and Bitbucket", () => {
  const detached = (s: ReturnType<typeof setup>) => git(s.ci, "checkout", "-q", "--detach", "HEAD");
  const latest = (s: ReturnType<typeof setup>) => {
    const name = readdirSync(join(s.root, "groundwork/results/ci"))[0];
    return { name, data: JSON.parse(readFileSync(join(s.root, "groundwork/results/ci", name), "utf8")) };
  };
  const base = { CI: "true", HOME: process.env.HOME, GIT_AUTHOR_NAME: undefined };

  it("a GitLab run on the default branch counts, from a detached checkout", async () => {
    const s = setup();
    detached(s);
    const env = { ...base, GITLAB_CI: "true", CI_COMMIT_SHA: s.sha, CI_COMMIT_BRANCH: "trunk", CI_DEFAULT_BRANCH: "trunk", CI_PIPELINE_ID: "88", CI_JOB_NAME: "test" };
    await run(s, { env });
    const { name, data } = latest(s);
    expect(data).toMatchObject({ source: "ci", commitSha: s.sha, ref: "refs/heads/trunk", defaultBranch: true });
    expect(name).toMatch(new RegExp(`^20261127T101500Z-${s.sha.slice(0, 7)}-88-test-[0-9a-f]{6}\\.json$`));
  });

  it("a GitLab merge request run doesn't count", async () => {
    const s = setup();
    detached(s);
    const env = { ...base, GITLAB_CI: "true", CI_COMMIT_SHA: s.sha, CI_DEFAULT_BRANCH: "main", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature" };
    await run(s, { env });
    expect(latest(s).data).toMatchObject({ defaultBranch: false });
  });

  it("a Bitbucket run on the default branch counts, from a detached checkout", async () => {
    const s = setup();
    detached(s);
    const env = { ...base, BITBUCKET_COMMIT: s.sha, BITBUCKET_BRANCH: "main", BITBUCKET_BUILD_NUMBER: "17", BITBUCKET_STEP_UUID: "{abc}" };
    await run(s, { env });
    const { name, data } = latest(s);
    expect(data).toMatchObject({ source: "ci", commitSha: s.sha, ref: "refs/heads/main", defaultBranch: true });
    expect(name).toMatch(new RegExp(`^20261127T101500Z-${s.sha.slice(0, 7)}-17-[0-9a-f]{6}\\.json$`));
  });

  it("a Bitbucket run on another branch doesn't count", async () => {
    const s = setup();
    detached(s);
    await run(s, { env: { ...base, BITBUCKET_COMMIT: s.sha, BITBUCKET_BRANCH: "feature", BITBUCKET_BUILD_NUMBER: "18" } });
    expect(latest(s).data).toMatchObject({ ref: "refs/heads/feature", defaultBranch: false });
  });

  it("--push works from a detached checkout", async () => {
    const s = setup();
    detached(s);
    const out = await run(s, { push: true, env: { ...base, GITLAB_CI: "true", CI_COMMIT_SHA: s.sha, CI_COMMIT_BRANCH: "main", CI_DEFAULT_BRANCH: "main" } });
    expect(out.code).toBe(0);
    expect(branchFiles(s.origin)).toHaveLength(1);
  });

  it("a declined push outside GitHub doesn't give GitHub advice", async () => {
    const s = setup();
    execFileSync("git", ["config", "receive.denyCreate", "true"], { cwd: s.origin });
    writeFileSync(join(s.origin, "hooks", "pre-receive"), "#!/bin/sh\necho declined >&2\nexit 1\n", { mode: 0o755 });
    const out = await run(s, { push: true, env: { ...base, GITLAB_CI: "true", CI_COMMIT_SHA: s.sha, CI_COMMIT_BRANCH: "main", CI_DEFAULT_BRANCH: "main" } });
    expect(out.code).toBe(1);
    expect(out.lines[0]).not.toMatch(/GitHub/);
    expect(out.lines[0]).toMatch(/push access/);
  });
});

describe("results add on other CI, after the review", () => {
  const base = { CI: "true", HOME: process.env.HOME, GIT_AUTHOR_NAME: undefined };
  const latest = (s: ReturnType<typeof setup>) => JSON.parse(readFileSync(join(s.root, "groundwork/results/ci", readdirSync(join(s.root, "groundwork/results/ci"))[0]), "utf8"));
  const detached = (s: ReturnType<typeof setup>) => git(s.ci, "checkout", "-q", "--detach", "HEAD");

  it("CI_COMMIT_SHA without GITLAB_CI isn't GitLab: a Woodpecker pull request into main doesn't count", async () => {
    const s = setup();
    detached(s);
    await run(s, { env: { ...base, CI_COMMIT_SHA: s.sha, CI_COMMIT_BRANCH: "main", CI_PIPELINE_EVENT: "pull_request" } });
    expect(latest(s).defaultBranch).toBe(false);
  });

  it("a GitLab merge request run never counts, even from a branch named like the default", async () => {
    const s = setup();
    detached(s);
    await run(s, { env: { ...base, GITLAB_CI: "true", CI_COMMIT_SHA: s.sha, CI_DEFAULT_BRANCH: "main", CI_MERGE_REQUEST_IID: "12", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "main" } });
    expect(latest(s)).toMatchObject({ ref: "refs/merge-requests/12/head", defaultBranch: false });
  });

  it("a Bitbucket pull request run never counts, even from a branch named like the default", async () => {
    const s = setup();
    detached(s);
    await run(s, { env: { ...base, BITBUCKET_COMMIT: s.sha, BITBUCKET_BRANCH: "main", BITBUCKET_PR_ID: "7" } });
    expect(latest(s)).toMatchObject({ ref: "refs/pull-requests/7/from", defaultBranch: false });
  });

  it("--push from a detached GitLab checkout records the branch, and the commit skips CI", async () => {
    const s = setup();
    detached(s);
    await run(s, { push: true, env: { ...base, GITLAB_CI: "true", CI_COMMIT_SHA: s.sha, CI_COMMIT_BRANCH: "main", CI_DEFAULT_BRANCH: "main" } });
    const [file] = branchFiles(s.origin);
    expect(JSON.parse(git(s.origin, "show", `groundwork-results:${file}`))).toMatchObject({ ref: "refs/heads/main", defaultBranch: true });
    expect(git(s.origin, "log", "-1", "--format=%B", "groundwork-results")).toContain("[skip ci]");
  });
});
