// The Groundwork GitHub Action. No dependencies: it runs on GitHub's node24 runtime as it is.
//
// - pull_request: sends the PR's description, commit messages and changed files to Groundwork, and creates or
//   updates one comment with the requirements and risks it names or touches, and the traceability gaps.
// - push to the default branch: finds the merged pull request and records it, so the work it names is tagged to
//   the product's collecting release.
// - with `junit`: uploads the JUnit reports for the commit.
//
// It never fails the job because Groundwork is unreachable or misconfigured, only on gaps with fail-on-gaps.

import { globSync, readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MARKER = "<!-- groundwork -->";
const MAX_FILES = 3000;
const MAX_COMMITS = 250;
/** GitHub refuses comments over 65,536 characters. */
const MAX_COMMENT = 65_000;

const fit = (markdown) =>
  markdown.length <= MAX_COMMENT ? markdown : `${markdown.slice(0, MAX_COMMENT)}\n\n…cut short: the full report is in the job summary.`;

/** `process.env`-style inputs in; the exit code out. `fetchImpl` is replaceable for tests. */
export async function run(env, fetchImpl = fetch) {
  const input = (name) => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const log = (level, msg) => console.log(`::${level}::${msg.replace(/\r?\n/g, "%0A")}`);
  const output = (name, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);

  const token = input("token");
  if (!token) {
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

  let code = 0;
  let commitSha = env.GITHUB_SHA;
  try {
    const pr = event.pull_request;
    if (pr) {
      commitSha = pr.head?.sha ?? commitSha;
      const changedPaths = (await pages(`/repos/${repo}/pulls/${pr.number}/files`, MAX_FILES)).map((f) => f.filename);
      const report = await groundwork("pr", { prBody: pr.body ?? "", commitMessages: await messages(pr.number), changedPaths });
      if (report) {
        // Decided before any write to GitHub, so a comment that can't be posted doesn't hide the gaps.
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
      }
    } else if (env.GITHUB_EVENT_NAME === "push" && event.ref === `refs/heads/${event.repository?.default_branch}`) {
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

  const patterns = input("junit").split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  if (patterns.length) {
    const files = [...new Set(patterns.flatMap((p) => globSync(p)))];
    if (!files.length) log("warning", `Groundwork: no JUnit reports match ${patterns.join(", ")}`);
    else {
      const result = await groundwork("test-results", { commitSha, ref: env.GITHUB_REF, junit: files.map((f) => readFileSync(f, "utf8")) });
      if (result) console.log(`Groundwork: recorded ${result.totals.passed} passed, ${result.totals.failed} failed, ${result.totals.skipped} skipped`);
    }
  }
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run(process.env);
}
