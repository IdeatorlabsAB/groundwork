import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchesOf, readConfig, writeConfig } from "../src/store/config";
import { load, renderItem } from "../src/store/files";
import { codeRunPath, keepLinked, loadResults, resultsFor, testRunPath, type StoredCodeRun, type StoredTestRun } from "../src/store/results";
import { validate } from "../src/store/validate";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A repository with a bare origin, checked out on main. */
function repo() {
  const top = mkdtempSync(join(tmpdir(), "gw-results-"));
  dirs.push(top);
  const origin = join(top, "origin.git");
  const root = join(top, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("remote", "add", "origin", origin);
  writeConfig(root, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [{ id: "sam", name: "Sam", role: "owner" }] });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("push", "-q", "origin", "main");
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  /** Put files on origin's results branch, as CI would, and fetch it; the checkout stays on main. */
  const onBranch = (files: Record<string, unknown>) => {
    git("checkout", "-q", "--orphan", "groundwork-results");
    git("rm", "-rqf", "--cached", ".");
    for (const [rel, data] of Object.entries(files)) write(rel, JSON.stringify(data));
    git("add", "--", ...Object.keys(files));
    git("commit", "-q", "-m", "results");
    git("push", "-q", "-f", "origin", "groundwork-results");
    for (const rel of Object.keys(files)) rmSync(join(root, rel));
    git("checkout", "-q", "-f", "main");
    git("branch", "-q", "-D", "groundwork-results");
    git("fetch", "-q", "origin", "+refs/heads/groundwork-results:refs/remotes/origin/groundwork-results");
  };
  return { root, git, write, onBranch };
}

const ciRun = (over: Partial<StoredCodeRun> = {}): StoredCodeRun => ({
  id: "00000000-0000-4000-8000-000000000001",
  commitSha: "abc1234def",
  ref: "refs/heads/main",
  at: "2026-11-27T10:15:00.000Z",
  source: "ci",
  defaultBranch: true,
  totals: { passed: 1, failed: 0, skipped: 0 },
  results: [{ path: "test/a.test.ts", name: "a > REQ-0002 works", status: "passed" }],
  ...over,
});
const toolRun = (over: Partial<StoredTestRun> = {}): StoredTestRun => ({
  source: "test-tool",
  tool: "testrail",
  project: "",
  id: "R3",
  title: "Smoke",
  product: "PRD-0001",
  version: "1.1",
  results: [{ id: "C101", status: "passed", endTime: "2026-11-27T10:00:00.000Z" }],
  recordedAt: "2026-11-27T11:00:00.000Z",
  recordedBy: "sam",
  ...over,
});
const config = (root: string) => readConfig(root);

describe("result file names", () => {
  it("names a code run by time, commit and job, so two jobs never collide", () => {
    expect(codeRunPath(ciRun(), "4521-1-test")).toBe("groundwork/results/ci/20261127T101500Z-abc1234-4521-1-test.json");
    expect(codeRunPath(ciRun(), "4521-1-e2e")).not.toBe(codeRunPath(ciRun(), "4521-1-test"));
  });

  it("names a test-tool run so the same run overwrites and look-alike ids don't", () => {
    expect(testRunPath(toolRun())).toBe(testRunPath(toolRun({ title: "Smoke, again" })));
    expect(testRunPath(toolRun({ id: "Run #1" }))).not.toBe(testRunPath(toolRun({ id: "run-1" })));
    expect(testRunPath(toolRun())).toMatch(/^groundwork\/results\/tools\/testrail-_-r3-[0-9a-f]{8}\.json$/);
  });
});

describe("keepLinked", () => {
  it("keepLinked keeps every result in a linked test's file", () => {
    const reqs = [{ codeTests: [{ path: "./test/a.test.ts", name: "x", linkedAt: "", linkedBy: "" }] }] as never;
    const kept = keepLinked(
      [
        { path: "test/a.test.ts", name: "x", status: "passed" },
        { path: "test/a.test.ts", name: "y", status: "failed" },
        { path: "test/b.test.ts", name: "z", status: "passed" },
      ],
      reqs,
    );
    expect(kept.map((r) => r.name)).toEqual(["x", "y"]);
  });
});

describe("loadResults", () => {
  it("reads ci results from origin/groundwork-results without checking it out", () => {
    const r = repo();
    r.onBranch({ [codeRunPath(ciRun(), "j1")]: ciRun() });
    const out = loadResults(r.root, config(r.root));
    expect(out.codeRuns.map((x) => x.id)).toEqual([ciRun().id]);
    expect(out.read).toEqual(["origin/groundwork-results", "working tree"]);
    expect(r.git("branch", "--show-current").trim()).toBe("main");
  });

  it("a file in both places counts once, and the branch wins", () => {
    const r = repo();
    const rel = codeRunPath(ciRun(), "j1");
    r.onBranch({ [rel]: ciRun() });
    r.write(rel, JSON.stringify(ciRun({ commitSha: "fff0000aaa" })));
    const out = loadResults(r.root, config(r.root));
    expect(out.codeRuns).toHaveLength(1);
    expect(out.codeRuns[0].commitSha).toBe("abc1234def");
  });

  it("reads only the newest 30 ci files", () => {
    const r = repo();
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 35; i++) {
      const run = ciRun({ id: `run-${i}`, at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() });
      files[codeRunPath(run, "j")] = run;
    }
    r.onBranch(files);
    const ids = loadResults(r.root, config(r.root)).codeRuns.map((x) => x.id);
    expect(ids).toHaveLength(30);
    expect(ids).not.toContain("run-0");
    expect(ids).toContain("run-34");
  });

  it("30 newer runs that don't count don't push the latest counting run out of the window", () => {
    const r = repo();
    const files: Record<string, unknown> = {};
    const counting = ciRun({ id: "main-run", at: "2026-11-01T00:00:00.000Z" });
    files[codeRunPath(counting, "j")] = counting;
    for (let i = 0; i < 30; i++) {
      const pr = ciRun({ id: `pr-${i}`, defaultBranch: false, ref: "refs/pull/7/merge", at: new Date(Date.UTC(2026, 10, 2, 0, i)).toISOString() });
      files[codeRunPath(pr, "j")] = pr;
    }
    r.onBranch(files);
    const loaded = loadResults(r.root, config(r.root));
    expect(resultsFor(loaded, "PRD-0001", "1.1").code.runs.map((x) => x.id)).toEqual(["main-run"]);
  });

  it("reads tools/ from the working tree only", () => {
    const r = repo();
    r.onBranch({ [testRunPath(toolRun({ id: "on-branch" }))]: toolRun({ id: "on-branch" }) });
    r.write(testRunPath(toolRun()), JSON.stringify(toolRun()));
    expect(loadResults(r.root, config(r.root)).testRuns.map((x) => x.id)).toEqual(["R3"]);
  });

  it("a malformed result file is skipped and reported with its source", () => {
    const r = repo();
    r.onBranch({ "groundwork/results/ci/20261101T000000Z-aaaaaaa-j.json": { nope: true } });
    r.write("groundwork/results/tools/broken.json", "{");
    const out = loadResults(r.root, config(r.root));
    expect(out.codeRuns).toEqual([]);
    expect(out.problems.map((p) => p.file)).toEqual(["groundwork-results:groundwork/results/ci/20261101T000000Z-aaaaaaa-j.json", "groundwork/results/tools/broken.json"]);
    const problems = validate(load(r.root), config(r.root), { root: r.root }).map((p) => `${p.level} ${p.file}`);
    // A warning: a bad file on the results branch can't be fixed in a pull request, so it mustn't fail every validate.
    expect(problems).toContain("warning groundwork/results/tools/broken.json");
  });

  it("works outside a git repository, from the working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "gw-nogit-"));
    dirs.push(root);
    writeConfig(root, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [] });
    mkdirSync(join(root, "groundwork/results/ci"), { recursive: true });
    writeFileSync(join(root, codeRunPath(ciRun(), "j")), JSON.stringify(ciRun()));
    const out = loadResults(root, readConfig(root));
    expect(out.codeRuns).toHaveLength(1);
    expect(out.read).toEqual(["working tree"]);
  });
});

describe("resultsFor", () => {
  const req = { codeTests: [{ path: "test/a.test.ts", name: "a > REQ-0002 works", linkedAt: "", linkedBy: "" }] };

  it("resultsFor counts only CI runs on the default branch", () => {
    const loaded = {
      codeRuns: [
        ciRun({ id: "feature", defaultBranch: false, at: "2026-11-28T00:00:00.000Z", results: [{ path: "test/a.test.ts", name: "a > REQ-0002 works", status: "failed" }] }),
        ciRun({ id: "laptop", source: "local", at: "2026-11-29T00:00:00.000Z", results: [{ path: "test/a.test.ts", name: "a > REQ-0002 works", status: "failed" }] }),
        ciRun(),
      ],
      testRuns: [],
      problems: [],
      read: [],
    };
    const t = resultsFor(loaded, "PRD-0001", "1.1");
    expect(t.code.runs.map((x) => x.id)).toEqual([ciRun().id]);
    expect(t.code.results.find((x) => x.name === req.codeTests[0].name)?.status).toBe("passed");
  });

  it("a linked test deleted from a kept file stops counting", () => {
    const newer = ciRun({ id: "newer", at: "2026-11-28T00:00:00.000Z", results: [{ path: "test/a.test.ts", name: "a > other", status: "passed" }] });
    const t = resultsFor({ codeRuns: [ciRun(), newer], testRuns: [], problems: [], read: [] }, "PRD-0001", "1.1");
    expect(t.code.results.map((x) => x.name)).toEqual(["a > other"]);
  });

  it("resultsFor takes the version's test-tool runs only", () => {
    const t = resultsFor({ codeRuns: [], testRuns: [toolRun(), toolRun({ id: "R4", version: "1.0" })], problems: [], read: [] }, "PRD-0001", "1.1");
    expect(t.runs.map((x) => x.id)).toEqual(["R3"]);
    expect(t.results).toEqual([{ tool: "testrail", project: "", id: "C101", runId: "R3", status: "passed", endTime: "2026-11-27T10:00:00.000Z" }]);
    expect(t.fetchedAt).toBe("2026-11-27T11:00:00.000Z");
  });
});

describe("config", () => {
  it("defaultBranch and resultsBranch come from config.yml", () => {
    const r = repo();
    expect(branchesOf(config(r.root))).toEqual({ defaultBranch: "main", resultsBranch: "groundwork-results" });
    writeFileSync(join(r.root, "groundwork/config.yml"), "name: Acme\ndefaultBranch: trunk\nresultsBranch: gw-results\n");
    expect(branchesOf(config(r.root))).toEqual({ defaultBranch: "trunk", resultsBranch: "gw-results" });
    void renderItem;
  });
});
