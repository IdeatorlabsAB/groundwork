import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Plain JavaScript, run by GitHub's node24 runtime.
import { run } from "../action/main.mjs";

type Call = { method: string; url: string; body?: unknown };

/** A fake fetch: answers by "METHOD path" prefix, records every call. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const v = routes[key];
    return v instanceof Response ? v : Response.json(v);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function env(event: object, over: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gw-action-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(event));
  const out = join(dir, "out");
  writeFileSync(out, "");
  return {
    dir,
    out,
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_SHA: "f".repeat(40),
      GITHUB_REF: "refs/pull/57/merge",
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_OUTPUT: out,
      INPUT_URL: "https://gw.test",
      INPUT_TOKEN: "gw_ci",
      "INPUT_GITHUB-TOKEN": "ghs_x",
      "INPUT_FAIL-ON-GAPS": "false",
      INPUT_JUNIT: "",
      ...over,
    } as Record<string, string>,
  };
}

const PR_EVENT = { pull_request: { number: 57, body: "Groundwork: REQ-0002", head: { sha: "a".repeat(40) } } };
const REPORT = { named: [], touched: [], unknownKeys: [], gaps: [{ type: "untested-requirement", key: "REQ-0002", title: "Import" }], markdown: "<!-- groundwork -->\n## Groundwork" };

describe("groundwork GitHub Action", () => {
  it("on a pull request, sends the changed files and commits and creates the comment", async () => {
    const { fetch, calls } = fakeFetch({
      "GET https://api.github.test/repos/acme/app/pulls/57/files": [{ filename: "src/a.ts" }],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [{ commit: { message: "Do it\n\nGroundwork: RSK-0001" } }],
      "POST https://gw.test/api/ci/pr": REPORT,
      "GET https://api.github.test/repos/acme/app/issues/57/comments": [{ id: 9, body: "unrelated" }],
      "POST https://api.github.test/repos/acme/app/issues/57/comments": { id: 10 },
    });
    const e = env(PR_EVENT);
    expect(await run(e.env, fetch)).toBe(0);
    expect(calls.find((c) => c.url === "https://gw.test/api/ci/pr")?.body).toEqual({
      prBody: "Groundwork: REQ-0002",
      commitMessages: ["Do it\n\nGroundwork: RSK-0001"],
      changedPaths: ["src/a.ts"],
    });
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { body: REPORT.markdown } });
    expect(readFileSync(e.out, "utf8")).toContain("gaps=1");
  });

  it("updates its earlier comment instead of adding another", async () => {
    const { fetch, calls } = fakeFetch({
      "GET https://api.github.test/repos/acme/app/pulls/57/files": [],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [],
      "POST https://gw.test/api/ci/pr": REPORT,
      "GET https://api.github.test/repos/acme/app/issues/57/comments": [{ id: 9, body: "<!-- groundwork -->\nold", user: { type: "Bot" } }],
      "PATCH https://api.github.test/repos/acme/app/issues/comments/9": {},
    });
    await run(env(PR_EVENT).env, fetch);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "https://api.github.test/repos/acme/app/issues/comments/9" });
  });

  it("fails on gaps only when fail-on-gaps is on", async () => {
    const routes = {
      "GET https://api.github.test/repos/acme/app/pulls/57/files": [],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [],
      "POST https://gw.test/api/ci/pr": REPORT,
      "GET https://api.github.test/repos/acme/app/issues/57/comments": [],
      "POST https://api.github.test/repos/acme/app/issues/57/comments": {},
    };
    expect(await run(env(PR_EVENT, { "INPUT_FAIL-ON-GAPS": "true" }).env, fakeFetch(routes).fetch)).toBe(1);
  });

  it("still reports gaps and fails on them when the comment can't be posted", async () => {
    const { fetch } = fakeFetch({
      "GET https://api.github.test/repos/acme/app/pulls/57/files": [],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [],
      "POST https://gw.test/api/ci/pr": REPORT,
      "GET https://api.github.test/repos/acme/app/issues/57/comments": [],
      "POST https://api.github.test/repos/acme/app/issues/57/comments": new Response("Resource not accessible by integration", { status: 403 }),
    });
    const e = env(PR_EVENT, { "INPUT_FAIL-ON-GAPS": "true" });
    expect(await run(e.env, fetch)).toBe(1);
    expect(readFileSync(e.out, "utf8")).toContain("gaps=1");
  });

  it("only updates a comment the Action itself wrote, and keeps it under GitHub's size limit", async () => {
    const { fetch, calls } = fakeFetch({
      "GET https://api.github.test/repos/acme/app/pulls/57/files": [],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [],
      "POST https://gw.test/api/ci/pr": { ...REPORT, markdown: `<!-- groundwork -->\n${"x".repeat(70_000)}` },
      "GET https://api.github.test/repos/acme/app/issues/57/comments": [{ id: 9, body: "<!-- groundwork --> quoted by a person", user: { type: "User" } }],
      "POST https://api.github.test/repos/acme/app/issues/57/comments": {},
    });
    await run(env(PR_EVENT).env, fetch);
    const last = calls.at(-1)!;
    expect(last.method).toBe("POST");
    expect((last.body as { body: string }).body.length).toBeLessThanOrEqual(65_536);
  });

  it("on a push to the default branch, records the merged pull request", async () => {
    const sha = "b".repeat(40);
    const { fetch, calls } = fakeFetch({
      [`GET https://api.github.test/repos/acme/app/commits/${sha}/pulls`]: [
        { number: 57, title: "Import", body: "Groundwork: REQ-0002", html_url: "https://github.com/acme/app/pull/57", merged_at: "2026-11-25T10:00:00Z", merge_commit_sha: sha },
      ],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [{ commit: { message: "Groundwork: RSK-0001" } }],
      "POST https://gw.test/api/ci/merge": { tagged: [{ key: "REQ-0002", release: "REL-0002" }], ignored: [], ticketLinked: ["REQ-0002"], changed: true },
    });
    const e = env({ ref: "refs/heads/main", repository: { default_branch: "main" } }, { GITHUB_EVENT_NAME: "push", GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main" });
    expect(await run(e.env, fetch)).toBe(0);
    expect(calls.find((c) => c.url === "https://gw.test/api/ci/merge")?.body).toEqual({
      prBody: "Groundwork: REQ-0002",
      commitMessages: ["Groundwork: RSK-0001"],
      repo: "acme/app",
      number: 57,
      title: "Import",
      url: "https://github.com/acme/app/pull/57",
      mergeSha: sha,
      mergedAt: "2026-11-25T10:00:00Z",
    });
  });

  it("uploads JUnit reports for the pull request's head commit", async () => {
    const { fetch, calls } = fakeFetch({
      "GET https://api.github.test/repos/acme/app/pulls/57/files": [],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [],
      "POST https://gw.test/api/ci/pr": { ...REPORT, gaps: [] },
      "GET https://api.github.test/repos/acme/app/issues/57/comments": [],
      "POST https://api.github.test/repos/acme/app/issues/57/comments": {},
      "POST https://gw.test/api/ci/test-results": { id: "run-1", totals: { passed: 1, failed: 0, skipped: 0 }, matched: [] },
    });
    const e = env(PR_EVENT);
    writeFileSync(join(e.dir, "junit.xml"), "<testsuite/>");
    e.env.INPUT_JUNIT = join(e.dir, "*.xml");
    expect(await run(e.env, fetch)).toBe(0);
    expect(calls.find((c) => c.url === "https://gw.test/api/ci/test-results")?.body).toEqual({ commitSha: "a".repeat(40), ref: "refs/pull/57/merge", defaultBranch: false, junit: ["<testsuite/>"] });
  });

  it("marks JUnit uploads from a push to the default branch", async () => {
    const sha = "c".repeat(40);
    const { fetch, calls } = fakeFetch({
      [`GET https://api.github.test/repos/acme/app/commits/${sha}/pulls`]: [],
      "POST https://gw.test/api/ci/test-results": { id: "run-1", totals: { passed: 1, failed: 0, skipped: 0 }, matched: [] },
    });
    const e = env({ ref: "refs/heads/main", repository: { default_branch: "main" } }, { GITHUB_EVENT_NAME: "push", GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main" });
    writeFileSync(join(e.dir, "junit.xml"), "<testsuite/>");
    e.env.INPUT_JUNIT = join(e.dir, "*.xml");
    await run(e.env, fetch);
    expect(calls.find((c) => c.url === "https://gw.test/api/ci/test-results")?.body).toMatchObject({ commitSha: sha, defaultBranch: true });
  });

  it("on a pull request with junit, sends the reports to /pr too", async () => {
    const { fetch, calls } = fakeFetch({
      "GET https://api.github.test/repos/acme/app/pulls/57/files": [],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [],
      "POST https://gw.test/api/ci/pr": { ...REPORT, gaps: [] },
      "GET https://api.github.test/repos/acme/app/issues/57/comments": [],
      "POST https://api.github.test/repos/acme/app/issues/57/comments": {},
      "POST https://gw.test/api/ci/test-results": { id: "run-1", totals: { passed: 1, failed: 0, skipped: 0 }, matched: [] },
    });
    const e = env(PR_EVENT);
    writeFileSync(join(e.dir, "junit.xml"), "<testsuite/>");
    e.env.INPUT_JUNIT = join(e.dir, "*.xml");
    await run(e.env, fetch);
    expect(calls.find((c) => c.url === "https://gw.test/api/ci/pr")?.body).toMatchObject({ junit: ["<testsuite/>"] });
  });

  it("marks scheduled runs on the default branch, looking the branch up when the event doesn't say", async () => {
    const { fetch, calls } = fakeFetch({
      "GET https://api.github.test/repos/acme/app?": { default_branch: "main" },
      "GET https://api.github.test/repos/acme/app": { default_branch: "main" },
      "POST https://gw.test/api/ci/test-results": { id: "run-1", totals: { passed: 1, failed: 0, skipped: 0 }, matched: [] },
    });
    const e = env({ schedule: "0 3 * * *" }, { GITHUB_EVENT_NAME: "schedule", GITHUB_REF: "refs/heads/main" });
    writeFileSync(join(e.dir, "junit.xml"), "<testsuite/>");
    e.env.INPUT_JUNIT = join(e.dir, "*.xml");
    expect(await run(e.env, fetch)).toBe(0);
    expect(calls.find((c) => c.url === "https://gw.test/api/ci/test-results")?.body).toMatchObject({ defaultBranch: true });
  });

  it("retries the PR report without the JUnit reports when Groundwork refuses them, and still fails on gaps", async () => {
    let prCalls = 0;
    const routes: Record<string, unknown> = {
      "GET https://api.github.test/repos/acme/app/pulls/57/files": [],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [],
      "GET https://api.github.test/repos/acme/app/issues/57/comments": [],
      "POST https://api.github.test/repos/acme/app/issues/57/comments": {},
      "POST https://gw.test/api/ci/test-results": new Response("bad", { status: 400 }),
    };
    const { fetch: base, calls } = fakeFetch(routes);
    const fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "https://gw.test/api/ci/pr") {
        prCalls++;
        const body = JSON.parse(init!.body!);
        calls.push({ method: "POST", url, body });
        return body.junit ? Response.json({ error: { reason: "bad_junit", message: "not XML" } }, { status: 400 }) : Response.json(REPORT);
      }
      return base(url, init as RequestInit);
    }) as unknown as typeof globalThis.fetch;
    const e = env(PR_EVENT, { "INPUT_FAIL-ON-GAPS": "true" });
    writeFileSync(join(e.dir, "junit.xml"), "<testsuite");
    e.env.INPUT_JUNIT = join(e.dir, "*.xml");
    expect(await run(e.env, fetch)).toBe(1);
    expect(prCalls).toBe(2);
    expect(calls.some((c) => c.url.endsWith("/issues/57/comments") && c.method === "POST")).toBe(true);
  });

  it("never fails the job when Groundwork is down or the token is missing", async () => {
    const down = fakeFetch({
      "GET https://api.github.test/repos/acme/app/pulls/57/files": [],
      "GET https://api.github.test/repos/acme/app/pulls/57/commits": [],
      "POST https://gw.test/api/ci/pr": new Response("oops", { status: 503 }),
    });
    expect(await run(env(PR_EVENT, { "INPUT_FAIL-ON-GAPS": "true" }).env, down.fetch)).toBe(0);
    const none = fakeFetch({});
    expect(await run(env(PR_EVENT, { INPUT_TOKEN: "" }).env, none.fetch)).toBe(0);
    expect(none.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Local mode: the report comes from the repository's own files, through the package's CLI.
// ---------------------------------------------------------------------------------------------

import { cpSync, existsSync } from "node:fs";
import { runCiPrCommand } from "../src/ci-cli";

type ExecCall = { cmd: string; args: string[]; cwd: string; env: Record<string, string | undefined> };

/** Runs `groundwork ci pr` in-process on the project GROUNDWORK_DIR names, and records every call. */
function fakeExec(over: (c: ExecCall) => { code: number; stdout: string; stderr: string } | undefined = () => undefined) {
  const calls: ExecCall[] = [];
  const exec = async (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => {
    const c = { cmd, args, ...opts };
    calls.push(c);
    const forced = over(c);
    if (forced) return forced;
    const g = args.indexOf("groundwork");
    const rest = args.slice(g + 1);
    if (rest[0] === "ci" && rest[1] === "pr") {
      const flag = (name: string) => rest.flatMap((a, i) => (a === name ? [rest[i + 1]] : a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : []));
      const out = runCiPrCommand(opts.env.GROUNDWORK_DIR!, {
        input: JSON.parse(readFileSync(flag("--input")[0], "utf8")),
        junit: flag("--junit"),
        linkBase: flag("--link-base")[0],
        pathPrefix: flag("--path-prefix")[0],
      });
      return { code: out.code, stdout: out.lines.join("\n"), stderr: "" };
    }
    return { code: 0, stdout: "Pushed to groundwork-results.", stderr: "" };
  };
  return { exec, calls };
}

/** A workspace holding acme, as actions/checkout leaves it. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "gw-action-ws-"));
  cpSync(join(__dirname, "../examples/acme/groundwork"), join(dir, "groundwork"), { recursive: true });
  return dir;
}

const LOCAL_PR = { pull_request: { number: 57, body: "Adds the wizard.\n\nGroundwork: REQ-0002", head: { sha: "a".repeat(40) } }, repository: { default_branch: "main" } };
const prRoutes = (extra: Record<string, unknown> = {}) => ({
  "GET https://api.github.test/repos/acme/app/pulls/57/files": [{ filename: "src/a.ts" }],
  "GET https://api.github.test/repos/acme/app/pulls/57/commits": [{ commit: { message: "Do it" } }],
  "GET https://api.github.test/repos/acme/app/issues/57/comments": [],
  "POST https://api.github.test/repos/acme/app/issues/57/comments": { id: 10 },
  ...extra,
});
const localEnv = (event: object, ws: string, over: Record<string, string> = {}) =>
  env(event, { INPUT_MODE: "local", INPUT_TOKEN: "", GITHUB_WORKSPACE: ws, GITHUB_SERVER_URL: "https://github.com", RUNNER_TEMP: mkdtempSync(join(tmpdir(), "gw-runner-")), ...over });

describe("the Action's local mode", () => {
  it("local mode comments with the gaps from the repository's files", async () => {
    const ws = workspace();
    const { fetch, calls } = fakeFetch(prRoutes());
    const { exec, calls: execs } = fakeExec();
    const e = localEnv(LOCAL_PR, ws);
    expect(await run(e.env, fetch, exec)).toBe(0);
    const comment = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/57/comments"))!.body as { body: string };
    expect(comment.body).toContain("<!-- groundwork -->");
    expect(comment.body).toContain("REQ-0002");
    expect(comment.body).toContain("no tests are linked");
    expect(readFileSync(e.out, "utf8")).toContain("gaps=1");
    // npx runs outside the PR's checkout, pointed at the project, with the Action's own version.
    const version = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")).version;
    expect(execs[0]).toMatchObject({ cmd: "npx", args: expect.arrayContaining(["-y", "-p", `groundwork-mcp@${version}`, "groundwork", "ci", "pr"]) });
    expect(execs[0].cwd.startsWith(ws)).toBe(false);
    expect(execs[0].env.GROUNDWORK_DIR).toBe(ws);
    expect(execs[0].args).toContain(`--link-base=https://github.com/acme/app/blob/${"a".repeat(40)}/`);
  });

  it("local mode makes no request to the Groundwork URL", async () => {
    const ws = workspace();
    const { fetch, calls } = fakeFetch(prRoutes());
    await run(localEnv(LOCAL_PR, ws, { INPUT_JUNIT: "" }).env, fetch, fakeExec().exec);
    expect(calls.filter((c) => c.url.startsWith("https://gw.test"))).toEqual([]);
  });

  it("local mode updates its own comment instead of adding one", async () => {
    const ws = workspace();
    const { fetch, calls } = fakeFetch(
      prRoutes({ "GET https://api.github.test/repos/acme/app/issues/57/comments": [{ id: 9, body: "<!-- groundwork -->\nold", user: { type: "Bot" } }], "PATCH https://api.github.test/repos/acme/app/issues/comments/9": {} }),
    );
    await run(localEnv(LOCAL_PR, ws).env, fetch, fakeExec().exec);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "https://api.github.test/repos/acme/app/issues/comments/9" });
  });

  it("local mode fails the check on gaps with fail-on-gaps", async () => {
    const ws = workspace();
    const { fetch } = fakeFetch(prRoutes());
    expect(await run(localEnv(LOCAL_PR, ws, { "INPUT_FAIL-ON-GAPS": "true" }).env, fetch, fakeExec().exec)).toBe(1);
  });

  it("local mode on a fork still reports gaps in the summary", async () => {
    const ws = workspace();
    const { fetch } = fakeFetch(prRoutes({ "POST https://api.github.test/repos/acme/app/issues/57/comments": new Response("Resource not accessible by integration", { status: 403 }) }));
    const summary = join(ws, "summary.md");
    const e = localEnv(LOCAL_PR, ws, { GITHUB_STEP_SUMMARY: summary });
    expect(await run(e.env, fetch, fakeExec().exec)).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("no tests are linked");
    expect(readFileSync(e.out, "utf8")).toContain("gaps=1");
  });

  it("local mode passes the JUnit files and the subfolder to the CLI", async () => {
    const ws = workspace();
    const project = join(ws, "apps/web");
    cpSync(join(ws, "groundwork"), join(project, "groundwork"), { recursive: true });
    writeFileSync(join(ws, "junit.xml"), "<testsuites/>");
    const { fetch } = fakeFetch(prRoutes());
    const { exec, calls: execs } = fakeExec();
    await run(localEnv(LOCAL_PR, ws, { INPUT_JUNIT: "junit.xml", "INPUT_WORKING-DIRECTORY": "apps/web" }).env, fetch, exec);
    expect(execs[0].env.GROUNDWORK_DIR).toBe(project);
    expect(execs[0].args).toEqual(expect.arrayContaining([`--junit=${join(ws, "junit.xml")}`, "--path-prefix=apps/web/"]));
  });

  it("local mode pushes results on the default branch", async () => {
    const ws = workspace();
    writeFileSync(join(ws, "junit.xml"), "<testsuites/>");
    const { fetch } = fakeFetch({});
    const { exec, calls: execs } = fakeExec();
    const e = localEnv({ repository: { default_branch: "main" } }, ws, { GITHUB_EVENT_NAME: "schedule", GITHUB_REF: "refs/heads/main", INPUT_JUNIT: "junit.xml" });
    expect(await run(e.env, fetch, exec)).toBe(0);
    expect(execs).toHaveLength(1);
    expect(execs[0].args.slice(execs[0].args.indexOf("groundwork"))).toEqual(["groundwork", "results", "add", join(ws, "junit.xml"), "--push"]);
    expect(execs[0].env).toMatchObject({ GROUNDWORK_DIR: ws, GITHUB_REF: "refs/heads/main" });
  });

  it("local mode doesn't push results on a pull request", async () => {
    const ws = workspace();
    writeFileSync(join(ws, "junit.xml"), "<testsuites/>");
    const { fetch } = fakeFetch(prRoutes());
    const { exec, calls: execs } = fakeExec();
    await run(localEnv(LOCAL_PR, ws, { INPUT_JUNIT: "junit.xml" }).env, fetch, exec);
    expect(execs.some((c) => c.args.includes("results"))).toBe(false);
  });

  it("an npx failure is a warning, not a failed job", async () => {
    const ws = workspace();
    const { fetch, calls } = fakeFetch(prRoutes());
    const { exec } = fakeExec(() => ({ code: 1, stdout: "", stderr: "npm ERR! network" }));
    expect(await run(localEnv(LOCAL_PR, ws).env, fetch, exec)).toBe(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("with fail-on-gaps, a check that couldn't run fails the job", async () => {
    const ws = workspace();
    const { fetch } = fakeFetch(prRoutes());
    const { exec } = fakeExec(() => ({ code: 1, stdout: "", stderr: "No groundwork/config.yml in /x" }));
    expect(await run(localEnv(LOCAL_PR, ws, { "INPUT_FAIL-ON-GAPS": "true" }).env, fetch, exec)).toBe(1);
  });

  it("an older package without ci pr says to set groundwork-version", async () => {
    const ws = workspace();
    const { fetch } = fakeFetch(prRoutes());
    const { exec } = fakeExec(() => ({ code: 1, stdout: "", stderr: "Unknown option '--input'" }));
    const logs: string[] = [];
    const spy = console.log;
    console.log = (m: string) => void logs.push(String(m));
    try {
      await run(localEnv(LOCAL_PR, ws).env, fetch, exec);
    } finally {
      console.log = spy;
    }
    expect(logs.join("\n")).toContain("groundwork-version");
  });

  it("the package runs without the workflow's tokens", async () => {
    const ws = workspace();
    const { fetch } = fakeFetch(prRoutes());
    const { exec, calls: execs } = fakeExec();
    await run(localEnv(LOCAL_PR, ws).env, fetch, exec);
    expect(Object.keys(execs[0].env).filter((k) => k.startsWith("INPUT_"))).toEqual([]);
  });

  it("falls back to the latest package when the Action's own version isn't published", async () => {
    const ws = workspace();
    const { fetch } = fakeFetch(prRoutes());
    const { exec, calls: execs } = fakeExec((c) => (c.args.some((a) => a.startsWith("groundwork-mcp@") && a !== "groundwork-mcp@latest") ? { code: 1, stdout: "", stderr: "npm ERR! code ETARGET\nnpm ERR! notarget No matching version found" } : undefined));
    await run(localEnv(LOCAL_PR, ws).env, fetch, exec);
    expect(execs.map((c) => c.args.find((a) => a.startsWith("groundwork-mcp@")))).toEqual([expect.stringMatching(/^groundwork-mcp@\d/), "groundwork-mcp@latest"]);
    void existsSync;
  });

  it("refuses a groundwork-version that isn't a version", async () => {
    const ws = workspace();
    const { fetch } = fakeFetch(prRoutes());
    const { exec, calls: execs } = fakeExec();
    expect(await run(localEnv(LOCAL_PR, ws, { "INPUT_GROUNDWORK-VERSION": "1.0; rm -rf /" }).env, fetch, exec)).toBe(0);
    expect(execs).toEqual([]);
  });
});
