# PR 6: The GitHub Action's local mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Teams without a web app account get the Action's two jobs from their own repository's files:
- **On a pull request,** one comment lists the requirements and risks the PR names (in its `Groundwork:` trailer) or touches (through `codeRefs`), and the traceability gaps. `fail-on-gaps` fails the check.
- **On the default branch,** it records the JUnit results with `groundwork results add --push`.

**Architecture:**
- **The logic lives in the package**, tested like the rest. Port the web app's `trailer.ts` (`groundworkKeys`) and `pr-report.ts` (`prReport`) into `src/core`, adapted to local ids and to file links instead of web app URLs. Expose them as `groundwork ci pr`, which reads the PR's description, commit messages and changed paths from files and prints `{ gaps, markdown, … }` as JSON.
- **The Action stays dependency-free.** With `mode: local`, it gathers the PR data from the GitHub API as it already does, runs the package's CLI (`npx -y -p groundwork-mcp@<version> groundwork …`), and posts or updates the comment with the workflow's token.
- **No change in cloud mode.** `mode` defaults to `cloud`, so existing users see nothing different. A missing token in cloud mode still only logs a notice: forked PRs don't get secrets, and switching to local then would be a surprise.

**Spec:** `docs/superpowers/specs/2026-11-26-local-traceability-design.md`, section "Action local mode (PR 6)".

## Global Constraints

- Branch `action-local`, one PR. The user merges after CI passes.
- **Gap types and wording are the web app's** (`untested-requirement`, `unnamed-approved-change`, `unmitigated-high-risk`, `failed-code-test`, `code-tests-not-run`), with "Groundwork" kept and links pointing at files.
- **Keys** are local ids (`REQ-0042`, `RSK-0007`), matched case-insensitively from the trailer, as in the web app.
- **Links** are `<link-base><path>` when `--link-base` is given. The Action passes `${GITHUB_SERVER_URL}/${repo}/blob/${headSha}/`, and the item's path is its file. Without a link base, the comment shows the path as code.
- **The comment marker** `<!-- groundwork -->` and the update-in-place logic are the Action's existing code, shared by both modes.
- **The version run by `npx`** is the input `groundwork-version` (default `latest`; the README tells teams to pin it).
- **Merge tagging to a collecting release has no local equivalent** (local versions have no "collecting" release). The README says so, and that in local mode a merge records nothing but results.
- **Network:** the Action already needs GitHub's API. `npx` needs the npm registry, as any `npx groundwork-mcp` install does.

## Review Focus

1. **A PR from a fork** gets no write token. Commenting fails with a warning, never a crash, and the gaps still go to the job summary and `gaps` output, as cloud mode does today. Test: Task 3, `local mode on a fork still reports gaps in the summary`.
2. **A PR that changes `groundwork/` itself**, e.g. adding the requirement it names. The report is built from the PR's head checkout, so the new requirement counts. Test: Task 2, `ci pr reads the items as they are in the checkout`.
3. **A trailer naming an id that doesn't exist, or a hypothesis id** (only requirements and risks count). Both are listed as not found, as in the web app. Test: Task 1, `unknown and non-requirement keys are listed as not found`.
4. **A repository where `groundwork/` is in a subfolder.** The Action takes an input `working-directory` (default `.`), and both the CLI and `results add` run there. `changedPaths` come from GitHub as repository paths, and `codeRefs` are relative to the project root, so paths are made relative to the working directory before matching. Test: Task 2, `ci pr matches codeRefs when the project is in a subfolder`.

---

### Task 1: Trailer keys and the PR report in core

**Files:**
- Create: `src/core/pr-report.ts`, porting `groundworkKeys` and `prReport` from the web app's `src/lib/ci/trailer.ts` and `pr-report.ts`. `ItemRef.url` becomes `link?: string`, plus `file`. The function takes `{ keys, changedPaths, items, matrix, files: Map<id, path>, linkBase?, results? }`.
- Create: `test/pr-report.test.ts`, porting the web app's `test/ci-pr-report.test.ts` cases with local ids. Add:
  - `unknown and non-requirement keys are listed as not found`;
  - `links point at files under the link base`;
  - `without a link base, the comment shows file paths`.

Steps:
- [ ] Write the tests and watch them fail.
- [ ] Implement.
- [ ] Run `npm test && npx tsc --noEmit`, then commit together with this plan: `"PR report and trailer keys, ported from the web app"`.

### Task 2: `groundwork ci pr`

**Files:**
- Create: `src/ci-cli.ts`, exporting `runCiPrCommand(root, cwd, opts: { body?: string; commits?: string[]; changed: string[]; junit?: string[]; linkBase?: string; repoPrefix?: string }): Out`.
- Modify: `src/cli.ts`. `groundwork ci pr --body-file <f> --commits-file <f> --changed-file <f> [--junit <glob>…] [--link-base <url>]` prints JSON `{ named, touched, unknownKeys, gaps, markdown }`.
  - `--commits-file` holds the commit messages separated by NUL.
  - `--changed-file` holds one path per line.
  - The repository prefix of the project (`git rev-parse --show-prefix`) is stripped from changed paths, and paths outside the project are dropped.
- Test: `test/ci-cli.test.ts`:
  - `ci pr reads the items as they are in the checkout`;
  - `ci pr matches codeRefs when the project is in a subfolder`;
  - `ci pr with junit reports failed linked tests`;
  - `ci pr prints valid JSON with the markdown`.

Steps:
- [ ] Write the tests and watch them fail.
- [ ] Implement.
- [ ] Run `npm test && npx tsc --noEmit && npm run build`, then commit: `"groundwork ci pr: the PR report from the repository's own files"`.

### Task 3: The Action's local mode

**Files:**
- Modify: `action/action.yml`, adding the inputs:
  - `mode`: `cloud` or `local`, default `cloud`;
  - `groundwork-version`: default `latest`;
  - `working-directory`: default `.`;
  - `push-results`: default `true`, used in local mode only.

  The descriptions say which inputs apply to which mode.
- Modify: `action/main.mjs`. `run(env, fetchImpl, exec = defaultExec)`. In `mode: local`:
  - **On a pull request,** fetch the body, commits and changed files as today, and write them to temp files. Then `exec("npx", ["-y", "-p", `groundwork-mcp@${version}`, "groundwork", "ci", "pr", …])` in `working-directory`, and parse the JSON. The gaps output, `fail-on-gaps`, the job summary and the comment upsert are the existing code, used as they are.
  - **On a push to the default branch** with `junit` and `push-results`, `exec(npx … "groundwork", "results", "add", ...patterns, "--push")`. Its output goes to the log, and a failure is a warning, never a failed job.
  - **Anywhere else,** a notice: "local mode: nothing to do on <event>".
  - **Errors.** An `exec` failure (npx can't install, or the CLI exits non-zero without JSON) is a warning, and the job doesn't fail.
- Create: `test/action.test.ts`, with a fake fetch as in the web app's `test/github-action.test.ts`, plus an injected `exec` that calls `runCiPrCommand` and `runResultsCommand` in-process on a temp project:
  - `local mode comments with the gaps from the repository's files`;
  - `local mode updates its own comment instead of adding one`;
  - `local mode fails the check on gaps with fail-on-gaps`;
  - `local mode on a fork still reports gaps in the summary`;
  - `local mode pushes results on the default branch`;
  - `local mode doesn't push results on a pull request`;
  - `cloud mode without a token still only logs a notice`;
  - `an npx failure is a warning, not a failed job`.

Steps:
- [ ] Write the tests and watch them fail.
- [ ] Implement.
- [ ] Run `npm test`, then commit: `"The Action's local mode: PR comments and results from the repository"`.

### Task 4: Docs and PR

- **`action/README.md`:** a "Without a Groundwork account (local mode)" section, with a workflow using `mode: local`, `permissions: contents: write, pull-requests: write`, a pinned `groundwork-version`, `junit`, and `if: ${{ !cancelled() }}`. Say what local mode does and doesn't do (no merge tagging).
- **The main README's** "Test results from CI" section shows the Action as the simpler option.
- **SPEC, CHANGELOG.**
- **Verify:** `npm test && npx tsc --noEmit && npm run build`.
- **Then:** the final review (a fresh reviewer, end to end: build, `npm pack`, run the Action's `run()` against a fake GitHub with a real `npx -p ./groundwork-mcp-*.tgz`), the fix pass, push, open the PR, watch CI.

---

## Revisions after the plan review (they override the tasks above)

1. **The CLI version is the Action's own.** `groundwork-version` defaults to empty, meaning the version in the tag's `package.json` (`new URL("../package.json", import.meta.url)`). If that version isn't on npm (the Action used from `@main`), it falls back to `latest` with a warning. The version is checked against `^[\w.\-]+$`.
2. **Local mode branches first.** In `run()`, `mode === "local"` is checked before the token check, and local mode never calls the cloud (`groundwork("pr" | "merge" | "test-results")`). `token` is `required: false`. Test: `local mode makes no request to the Groundwork URL`.
3. **`npx` never runs in the PR's checkout.** Its working directory is `RUNNER_TEMP` (or the OS temp dir), and the CLI finds the project through `GROUNDWORK_DIR=<workspace>/<working-directory>`. The README says to use `pull_request`, never `pull_request_target`.
4. **Titles from the PR's files are inert in the comment.** Markdown is escaped everywhere, `@` gets a zero-width space, and `<` is escaped, so no comment marker can be forged. This is done in Task 1, with tests.
5. **JUnit files resolve once.** The Action expands the globs from the workspace and passes absolute paths to both `ci pr --junit` and `results add`.
6. **Results are recorded on any run on the default branch** (push, schedule, workflow_dispatch), using the existing `onDefaultBranch`. The `push-results` input is cut.
7. **`results add` gets the run's environment.** The default `exec` passes the `env` given to `run()`, plus `GROUNDWORK_DIR`. The README says it needs `contents: write`, `actions/checkout`'s persisted credentials, and a ruleset that allows `groundwork-results`.
8. **Windows.** On `win32`, `npx.cmd` runs with `shell: true`. Only temp-file paths and the checked version are passed. `maxBuffer` is 10 MB, and only stdout is parsed.
9. **Types.** `action/main.d.mts` declares `run`, so `tsc` accepts the test's import.
10. **Cloud mode is proven unchanged.** The web app's whole `test/github-action.test.ts` is copied into `test/action.test.ts` first (the code is the same) and stays green. The local-mode tests are added next to it.
11. **Renamed files** also count by their `previous_filename`. When the CLI fails, `gaps` is left unset and the README says so.
12. **Simpler CLI input.** `groundwork ci pr --input <pr.json> [--junit <file>…] [--link-base <url>] [--path-prefix <dir/>]`, where `pr.json` is `{ body, commits, changed }`. The prefix comes from the Action's `working-directory`, not from git.
