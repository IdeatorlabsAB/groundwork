import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { load, save } from "../src/store/files";

/**
 * The example pipelines in examples/ci, run for real: each groundwork job's script lines, in bash, against a local
 * "origin", with the variables GitLab or Bitbucket would set. `npx -p groundwork-mcp@… groundwork` runs this checkout's
 * CLI. What can't run here is the YAML's meaning to GitLab and Bitbucket (rules, stages, artifacts).
 */

const REPO = join(__dirname, "..");
const top = mkdtempSync(join(tmpdir(), "gw-ci-examples-"));
const bin = join(top, "bin");
const built = join(REPO, "node_modules/.cache/gw-ci-examples");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const JUNIT = `<testsuites><testsuite name="a"><testcase classname="test/import-audit.test.ts" name="import audit &gt; REQ-0003 records who, when and which file" file="test/import-audit.test.ts"/></testsuite></testsuites>`;

beforeAll(() => {
  execFileSync("npx", ["tsup", "src/cli.ts", "--no-config", "--format", "esm", "--target", "node22", "--out-dir", built, "--define.__VERSION__", '"0.0.0"'], { cwd: REPO, stdio: "ignore" });
  mkdirSync(bin);
  // npx -y -p groundwork-mcp@x groundwork <args>  →  node <this checkout's CLI> <args>
  writeFileSync(join(bin, "npx"), `#!/bin/sh\nwhile [ "$1" != "groundwork" ]; do shift; done\nshift\nexec node "${built}/cli.js" "$@"\n`);
  chmodSync(join(bin, "npx"), 0o755);
}, 60_000);
afterAll(() => rmSync(top, { recursive: true, force: true }));

/** origin with acme on main (REQ-0003 approved, with codeRefs), and a CI checkout of `branch` at its tip, detached. */
function project(name: string, branch: "main" | "feature") {
  const dir = join(top, name);
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  git(top, "init", "-q", "--bare", "-b", "main", origin);
  git(top, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "user.email", "seed@example.com");
  cpSync(join(REPO, "examples/acme/groundwork"), join(seed, "groundwork"), { recursive: true });
  const loaded = load(seed);
  save(seed, loaded, { ...loaded.items, requirements: loaded.items.requirements.map((r) => (r.id === "REQ-0003" ? { ...r, status: "approved" as const, plannedFor: "1.1", codeRefs: ["src/import"] } : r)) });
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "base");
  git(seed, "push", "-q", origin, "main");
  git(seed, "checkout", "-q", "-b", "feature");
  mkdirSync(join(seed, "src/import"), { recursive: true });
  writeFileSync(join(seed, "src/import/csv.ts"), "export {};\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "Faster import\n\nGroundwork: REQ-0003");
  git(seed, "push", "-q", origin, "feature");
  const ci = join(dir, "ci");
  git(top, "clone", "-q", "--branch", branch, `file://${origin}`, ci);
  git(ci, "checkout", "-q", "--detach", "HEAD");
  git(ci, "branch", "-q", "-D", branch);
  return { origin, ci, sha: git(ci, "rev-parse", "HEAD").trim() };
}

/** Runs a job's script lines in order, as the CI would, stopping at the first that fails. */
function runScript(lines: string[], cwd: string, env: Record<string, string>) {
  const out: { line: string; status: number | null; output: string }[] = [];
  for (const line of lines) {
    const r = spawnSync("bash", ["-c", line], { cwd, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME!, CI: "true", ...env }, encoding: "utf8" });
    out.push({ line, status: r.status, output: `${r.stdout}${r.stderr}` });
    if (r.status !== 0) break;
  }
  return out;
}

const groundworkLines = (lines: string[]) => lines.filter((l) => !/^npm ci|vitest/.test(l));
const results = (origin: string) => git(origin, "ls-tree", "-r", "--name-only", "groundwork-results").split("\n").filter(Boolean);

describe("examples/ci/gitlab-ci.yml", () => {
  const yml = parse(readFileSync(join(REPO, "examples/ci/gitlab-ci.yml"), "utf8"));

  it("the merge request job reports the gaps and fails on them", () => {
    const p = project("gl-mr", "feature");
    writeFileSync(join(p.ci, "junit.xml"), JUNIT);
    const env = { GITLAB_CI: "true", CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_DESCRIPTION: "Speeds up imports.", CI_COMMIT_SHA: p.sha };
    const out = runScript(yml["groundwork-check"].script, p.ci, env);
    expect(out.slice(0, 2).map((o) => o.status)).toEqual([0, 0]);
    expect(out[1].output).toMatch(/0 errors/);
    const report = out[2];
    expect(report.output).toMatch(/^<!-- groundwork -->/);
    expect(report.output).toContain("REQ-0003");
    expect(report.status).toBe(0); // REQ-0003 is named, tested and its test passed: no gaps
  });

  it("the merge request job fails when an approved requirement changes unnamed", () => {
    const p = project("gl-mr-gap", "feature");
    git(p.ci, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--amend", "-m", "Faster import");
    writeFileSync(join(p.ci, "junit.xml"), JUNIT);
    const env = { GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_DESCRIPTION: "", CI_COMMIT_SHA: p.sha, GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
    const out = runScript(yml["groundwork-check"].script, p.ci, env);
    expect(out.map((o) => o.status)).toEqual([0, 0, 1]);
    expect(out.at(-1)!.output).toContain("REQ-0003");
  });

  it("the default-branch job saves the results as release evidence, with the access token", () => {
    const p = project("gl-main", "main");
    writeFileSync(join(p.ci, "junit.xml"), JUNIT);
    // The token URL the job sets goes to the local origin instead.
    const url = "https://gitlab-ci-token:glpat-secret@gitlab.example.com/acme/app.git";
    const env = {
      GITLAB_CI: "true",
      CI_COMMIT_SHA: p.sha,
      CI_COMMIT_BRANCH: "main",
      CI_DEFAULT_BRANCH: "main",
      CI_PIPELINE_ID: "88",
      CI_JOB_NAME: "groundwork-results",
      GROUNDWORK_PUSH_TOKEN: "glpat-secret",
      CI_SERVER_PROTOCOL: "https",
      CI_SERVER_URL: "https://gitlab.example.com",
      CI_PROJECT_PATH: "acme/app",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${p.origin}.insteadOf`,
      GIT_CONFIG_VALUE_0: url,
    };
    const out = runScript(yml["groundwork-results"].script, p.ci, env);
    expect(out.map((o) => o.status)).toEqual([0, 0]);
    const files = results(p.origin);
    expect(files).toHaveLength(1);
    const run = JSON.parse(git(p.origin, "show", `groundwork-results:${files[0]}`));
    expect(run).toMatchObject({ source: "ci", commitSha: p.sha, ref: "refs/heads/main", defaultBranch: true });
  });

  it("without a push token, the job pushes with its own job token", () => {
    const p = project("gl-job-token", "main");
    writeFileSync(join(p.ci, "junit.xml"), JUNIT);
    const env = {
      GITLAB_CI: "true",
      CI_COMMIT_SHA: p.sha,
      CI_COMMIT_BRANCH: "main",
      CI_DEFAULT_BRANCH: "main",
      CI_JOB_TOKEN: "job-token",
      CI_SERVER_PROTOCOL: "https",
      CI_SERVER_URL: "https://gitlab.example.com:8443/gitlab",
      CI_PROJECT_PATH: "acme/app",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${p.origin}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://gitlab-ci-token:job-token@gitlab.example.com:8443/gitlab/acme/app.git",
    };
    expect(runScript(yml["groundwork-results"].script, p.ci, env).map((o) => o.status)).toEqual([0, 0]);
    expect(results(p.origin)).toHaveLength(1);
  });

  it("no pipeline runs for the results branch", () => {
    expect(yml.workflow.rules[0]).toEqual({ if: '$CI_COMMIT_BRANCH == "groundwork-results"', when: "never" });
  });
});

describe("examples/ci/bitbucket-pipelines.yml", () => {
  const yml = parse(readFileSync(join(REPO, "examples/ci/bitbucket-pipelines.yml"), "utf8"));

  it("the pull request step reports the gaps", () => {
    const p = project("bb-pr", "feature");
    mkdirSync(join(p.ci, "test-results"));
    writeFileSync(join(p.ci, "test-results/junit.xml"), JUNIT);
    const step = yml.pipelines["pull-requests"]["**"][0].step;
    const out = runScript(groundworkLines(step.script), p.ci, { BITBUCKET_COMMIT: p.sha, BITBUCKET_BRANCH: "feature", BITBUCKET_PR_DESTINATION_BRANCH: "main", BITBUCKET_BUILD_NUMBER: "17" });
    expect(out.map((o) => o.status)).toEqual([0, 0, 0]);
    expect(out[2].output).toMatch(/^<!-- groundwork -->/);
    expect(out[2].output).toContain("REQ-0003");
  });

  it("the main-branch step saves the results as release evidence", () => {
    const p = project("bb-main", "main");
    mkdirSync(join(p.ci, "test-results"));
    writeFileSync(join(p.ci, "test-results/junit.xml"), JUNIT);
    const step = yml.pipelines.branches.main[0].step;
    const out = runScript(step["after-script"], p.ci, { BITBUCKET_COMMIT: p.sha, BITBUCKET_BRANCH: "main", BITBUCKET_BUILD_NUMBER: "18" });
    expect(out.map((o) => o.status)).toEqual([0]);
    const run = JSON.parse(git(p.origin, "show", `groundwork-results:${results(p.origin)[0]}`));
    expect(run).toMatchObject({ source: "ci", commitSha: p.sha, ref: "refs/heads/main", defaultBranch: true });
  });
});
