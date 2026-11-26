// The Groundwork GitHub Action. No dependencies: it runs on GitHub's node24 runtime as it is.
//
// - pull_request: sends the PR's description, commit messages and changed files to Groundwork, and creates or
//   updates one comment with the requirements and risks it names or touches, and the traceability gaps.
// - push to the default branch: finds the merged pull request and records it, so the work it names is tagged to
//   the product's collecting release.
// - with `junit`: uploads the JUnit reports for the commit. On a pull request they also go into the comment request, so
//   it can say which named requirements' tests failed or didn't run. Only default-branch uploads count for releases.
//
// It never fails the job because Groundwork is unreachable or misconfigured, only on gaps with fail-on-gaps.
//
// mode: local, for teams without a Groundwork account: the report comes from the repository's own groundwork/ files,
// through the groundwork-mcp CLI (npx), and default-branch runs commit their JUnit results to the results branch.

import { execFile } from "node:child_process";
import { globSync, readFileSync, appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "<!-- groundwork -->";
const MAX_FILES = 3000;
const MAX_COMMITS = 250;
/** GitHub refuses comments over 65,536 characters. */
const MAX_COMMENT = 65_000;

const fit = (markdown) =>
  markdown.length <= MAX_COMMENT ? markdown : `${markdown.slice(0, MAX_COMMENT)}\n\n…cut short: the full report is in the job summary.`;

/** Runs a command and resolves with its exit code and output. Never throws. Windows needs npx.cmd through a shell. */
function defaultExec(cmd, args, { cwd, env }) {
  const win = process.platform === "win32";
  return new Promise((done) => {
    execFile(win ? `${cmd}.cmd` : cmd, args, { cwd, env, shell: win, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") }),
    );
  });
}

/** The groundwork-mcp version this Action was released with: the package.json of the same tag. */
function ownVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "latest";
  }
}

/** `process.env`-style inputs in; the exit code out. `fetchImpl` and `exec` are replaceable for tests. */
export async function run(env, fetchImpl = fetch, exec = defaultExec) {
  const input = (name) => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const log = (level, msg) => console.log(`::${level}::${msg.replace(/\r?\n/g, "%0A")}`);
  const output = (name, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);

  const mode = input("mode") || "cloud";
  if (mode !== "cloud" && mode !== "local") {
    log("warning", `Groundwork: mode is cloud or local, not "${mode}".`);
    return 0;
  }
  const token = input("token");
  // Local mode needs no token; checked first, so it never reaches the cloud calls below.
  if (mode === "cloud" && !token) {
    log("notice", "Groundwork: no token, so nothing was recorded. Set the GROUNDWORK_CI_TOKEN secret (forked PRs don't get secrets).");
    return 0;
  }
  const base = (input("url") || "https://groundwork.ideatorlabs.com").replace(/\/+$/, "");
  const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const repo = env.GITHUB_REPOSITORY;
  const gh = input("github-token");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));

  const github = async (method, path, body) => {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${gh}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
    return res.json();
  };
  const pages = async (path, max) => {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const batch = await github("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out.slice(0, max);
  };
  /** A Groundwork call. Null when it failed: the reason is logged as a warning. */
  const groundwork = async (path, body) => {
    try {
      const res = await fetchImpl(`${base}/api/ci/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (res.ok) return data;
      log("warning", `Groundwork /api/ci/${path}: ${data?.error?.message ?? `HTTP ${res.status}`}`);
    } catch (e) {
      log("warning", `Groundwork /api/ci/${path} is unreachable: ${e.message}`);
    }
    return null;
  };
  const messages = async (number) => (await pages(`/repos/${repo}/pulls/${number}/commits`, MAX_COMMITS)).map((c) => c.commit?.message ?? "");
  /** Post the report on the PR: gaps output and fail-on-gaps first, so a comment that can't be posted doesn't hide them. */
  const publish = async (pr, report) => {
    let code = 0;
    output("gaps", report.gaps.length);
    if (report.gaps.length && input("fail-on-gaps") === "true") {
      log("error", `Groundwork found ${report.gaps.length} traceability gap(s). See the PR comment or the job summary.`);
      code = 1;
    }
    const body = fit(report.markdown);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report.markdown}\n`);
    try {
      const comments = await pages(`/repos/${repo}/issues/${pr.number}/comments`, 1000);
      // Only a comment this Action wrote: a bot's, starting with the marker. A person quoting it isn't touched.
      const mine = comments.find((c) => c.user?.type === "Bot" && (c.body ?? "").startsWith(MARKER));
      if (mine) await github("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
      else await github("POST", `/repos/${repo}/issues/${pr.number}/comments`, { body });
    } catch (e) {
      log("warning", `Groundwork couldn't comment on the pull request (does the workflow have pull-requests: write?): ${e.message}`);
    }
    return code;
  };

  // JUnit reports, found once from the workspace: a pull request sends them with its comment request and uploads them too.
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const patterns = input("junit").split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  const files = [...new Set(patterns.flatMap((p) => globSync(p, { cwd: workspace }).map((f) => resolve(workspace, f))))];
  if (patterns.length && !files.length) log("warning", `Groundwork: no JUnit reports match ${patterns.join(", ")}`);

  // Only runs on the default branch count for release readiness (a push, a nightly schedule, a manual run); pull
  // requests don't. Events without the repository in their payload (schedule) look the branch up.
  let onDefaultBranch = false;
  if (!event.pull_request && env.GITHUB_REF?.startsWith("refs/heads/")) {
    const defaultBranch = event.repository?.default_branch ?? (await github("GET", `/repos/${repo}`).catch(() => null))?.default_branch;
    onDefaultBranch = !!defaultBranch && env.GITHUB_REF === `refs/heads/${defaultBranch}`;
  }

  if (mode === "local") return local({ env, input, log, event, exec, pages, messages, publish, repo, workspace, files, onDefaultBranch });

  const reports = files.map((f) => readFileSync(f, "utf8"));
  let code = 0;
  let commitSha = env.GITHUB_SHA;
  try {
    const pr = event.pull_request;
    if (pr) {
      commitSha = pr.head?.sha ?? commitSha;
      const changedPaths = (await pages(`/repos/${repo}/pulls/${pr.number}/files`, MAX_FILES)).map((f) => f.filename);
      const request = { prBody: pr.body ?? "", commitMessages: await messages(pr.number), changedPaths };
      // With this PR's test results the comment also covers failing tests. If Groundwork refuses them (bad or too
      // large), the comment and the gap check still go ahead without them.
      let report = reports.length ? await groundwork("pr", { ...request, junit: reports }) : null;
      if (!report && reports.length) log("warning", "Groundwork: the PR check ran without this PR's test results.");
      report ??= await groundwork("pr", request);
      if (report) code = await publish(pr, report);
    } else if (onDefaultBranch && env.GITHUB_EVENT_NAME === "push") {
      const pulls = await github("GET", `/repos/${repo}/commits/${env.GITHUB_SHA}/pulls`);
      const merged = pulls.find((p) => p.merged_at && p.merge_commit_sha === env.GITHUB_SHA) ?? pulls.find((p) => p.merged_at);
      if (!merged) log("notice", "Groundwork: this push isn't a merged pull request, so there's nothing to record.");
      else {
        const result = await groundwork("merge", {
          prBody: merged.body ?? "",
          commitMessages: await messages(merged.number),
          repo,
          number: merged.number,
          title: merged.title ?? "",
          url: merged.html_url,
          mergeSha: env.GITHUB_SHA,
          mergedAt: merged.merged_at,
        });
        if (result) {
          for (const t of result.tagged) console.log(`Groundwork: ${t.key} is in release ${t.release}`);
          for (const i of result.ignored) log("notice", `Groundwork: ${i.key} not tagged (${i.reason})`);
        }
      }
    }
  } catch (e) {
    log("warning", `Groundwork: ${e.message}`);
  }

  if (reports.length) {
    const result = await groundwork("test-results", { commitSha, ref: env.GITHUB_REF, defaultBranch: onDefaultBranch, junit: reports });
    if (result) console.log(`Groundwork: recorded ${result.totals.passed} passed, ${result.totals.failed} failed, ${result.totals.skipped} skipped`);
  }
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run(process.env);
}

/**
 * Local mode. npx runs in the runner's temp folder, never in the checkout: the PR's own .npmrc or package.json there
 * must not decide what gets run. The CLI finds the project through GROUNDWORK_DIR.
 */
async function local({ env, input, log, event, exec, pages, messages, publish, repo, workspace, files, onDefaultBranch }) {
  const requested = input("groundwork-version");
  const version = requested || ownVersion();
  if (!/^[\w.\-]+$/.test(version)) {
    log("warning", `Groundwork: groundwork-version "${version}" isn't a version, so nothing was run.`);
    return 0;
  }
  const projectDir = resolve(workspace, input("working-directory") || ".");
  const rel = relative(workspace, projectDir).split(sep).join("/");
  const prefix = rel ? `${rel}/` : "";
  const temp = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "groundwork-"));
  const childEnv = { ...env, GROUNDWORK_DIR: projectDir };
  /** groundwork <args> through npx: this tag's version, else the latest one when it isn't published (e.g. @main). */
  const cli = async (args) => {
    const once = (v) => exec("npx", ["-y", "-p", `groundwork-mcp@${v}`, "groundwork", ...args], { cwd: temp, env: childEnv });
    let out = await once(version);
    if (out.code && !requested && version !== "latest" && /ETARGET|notarget|E404|No matching version/i.test(out.stderr)) {
      log("warning", `Groundwork: groundwork-mcp@${version} isn't on npm, so the latest version was used.`);
      out = await once("latest");
    }
    return out;
  };

  const pr = event.pull_request;
  if (pr) {
    try {
      const changed = (await pages(`/repos/${repo}/pulls/${pr.number}/files`, MAX_FILES)).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
      const inputFile = join(temp, "pr.json");
      writeFileSync(inputFile, JSON.stringify({ body: pr.body ?? "", commits: await messages(pr.number), changed }));
      const server = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
      const sha = pr.head?.sha ?? env.GITHUB_SHA;
      const out = await cli(["ci", "pr", "--input", inputFile, "--link-base", `${server}/${repo}/blob/${sha}/`, "--path-prefix", prefix, ...files.flatMap((f) => ["--junit", f])]);
      let report = null;
      try {
        report = out.code === 0 ? JSON.parse(out.stdout) : null;
      } catch {
        report = null;
      }
      if (!report) {
        log("warning", `Groundwork: the PR check didn't run: ${(out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${out.code}`}`);
        return 0;
      }
      return await publish(pr, report);
    } catch (e) {
      log("warning", `Groundwork: ${e.message}`);
      return 0;
    }
  }
  if (onDefaultBranch && files.length) {
    const out = await cli(["results", "add", ...files, "--push"]);
    for (const line of `${out.stdout}`.trim().split("\n").filter(Boolean)) console.log(`Groundwork: ${line}`);
    if (out.code) log("warning", `Groundwork: the results weren't recorded: ${(out.stderr || out.stdout).trim().split("\n").slice(-2).join(" ")}`);
    return 0;
  }
  log("notice", `Groundwork (local mode): nothing to do on ${env.GITHUB_EVENT_NAME ?? "this event"}${onDefaultBranch ? " without junit reports" : ""}.`);
  return 0;
}
