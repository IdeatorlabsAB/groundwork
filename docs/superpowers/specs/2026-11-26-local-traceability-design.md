# Local traceability: risks, tests, results, release sign-off

Date: 2026-11-26. Repos: `IdeatorlabsAB/groundwork` (this one, "local") and `ganjilive/centropic-prototype` ("web app").

## Intent

Teams with a legacy product, and compliance or security reasons not to put their requirements, risks and test evidence in an outside service, get the web app's full traceability chain inside their own repository: baseline → own requirements imported → tickets → tests → risks and mitigations → CI results → a signed-off release report. They use the open-source `groundwork-mcp` package and their coding agent, with no account.

When a team moves to the web app later, `groundwork import --to <web app>` carries everything across unchanged, keys included (`RSK-0007` stays `RSK-0007`). After the switch only the MCP server changes: the agent's plan → build → PR loop and the `Groundwork:` trailer stay the same.

## Goals

1. Risks with mitigations, including risks reverse-engineered in the baseline.
2. Tests linked to requirements: code tests and cases in any test-management tool.
3. CI test results committed to the repository and matched to linked tests.
4. A release readiness check with blockers, a frozen sign-off record, and a traceability report (Markdown, CSV).
5. A planning-workflow skill for turning the team's own requirement documents into Groundwork requirements.
6. A local mode for the GitHub Action (PR comment with gaps, results commit).
7. Lossless migration of every new kind into the web app, with the web app import extended.

**Done means:** an end-to-end migration test of `examples/acme` with risks, tests and results into a web app workspace, then the web app's `check_release` gives the same blockers as the local `groundwork check release`.

## Non-goals

- Two-way sync between local files and the web app. Migration is one-time. The folder is marked `migrated:` and local writes stop, as today. Re-running with `--overwrite` covers a team that kept working locally during a short switch.
- Printable HTML or PDF reports. Markdown and CSV only for now. Markdown prints through any renderer.
- A shared npm package used by both repos (see Approaches).
- Calling test-management or tracker APIs from Groundwork. The agent uses each tool's own connection and records what it reads, as the web app does.

## Anti-goals

- Anything that needs a server, an account or network access for the local tools to work (import aside).
- A local kind or field the web app can't represent. That would break "nothing lost on the switch".
- Local scoring, readiness or test-status rules that disagree with the web app's.

## Constraints

- Both repos: work on a branch, one PR per step, never push to `main`, merge only when the user asks and CI passes.
- File format rules in `SPEC.md` apply to new kinds: Markdown + YAML frontmatter, ids `PREFIX-NNNN` never reused, unknown fields kept, `validate --against` / `renumber` handle id clashes.
- Adding optional kinds and fields doesn't bump `schemaVersion` (SPEC "Versioning").
- Rules live in `src/core`, so the MCP server and the CLI apply them the same way.
- Import body cap of 4 MB stays (`src/store/import.ts`). Results files must stay small.

## Approaches

**Sharing the rules between repos.** Three ways were considered:

- **A. Port and pin with shared fixtures (chosen).** Copy the web app's pure modules into `src/core`, adapted to local types. A parity fixture runs in both repos' test suites, and the e2e migration test proves they agree. This keeps the package dependency-free and leaves the web app alone apart from the test-case generalisation.
- B. The web app imports `groundwork-mcp/core`. There'd be one source of truth, but the web app's `Release`/`releaseIds` model needs an adapter, and every rule change would need an npm release first. Revisit if the two drift in practice.
- C. A third shared package: B with more packaging. Dropped.

**Where CI results live.** Committed to the repo (chosen) rather than read from JUnit when the report is built. CI artefacts expire, and committed results are durable evidence that migrates onto the web app's code runs.

**Test-management tools.** Generalise both repos now (chosen) rather than local-only with Qase-compatible import. A local-only shape would drop TestRail and other cases at migration.

**Sign-off.** Mirror the web app's frozen `ReleaseRecord` (chosen) rather than relying on git history. An auditor gets a fixed record, and the web app gets something to import.

## Decisions

### Risks (PR 1)

- New kind **Risk**, folder `risks/`, prefix `RSK`. The fields match the web app's `Risk`: **`title`**, **`hazard`**, **`harm`**, **`probability`**, **`severity`** (integers 1..matrix size), `residualProbability`, `residualSeverity`, `mitigationIds` (requirement ids), `category`, `product` (product id), `versions`, `owner`, `codeRefs`, `origin` (`existing-product` for baseline) and `originNote`, `createdAt`, `updatedAt`.
- `category`: `security` | `domain` with a free-text `domain` label (e.g. `patient-safety`, `financial`). The web app's `Risk` has none of `category`, `domain`, `origin`, `originNote`, and its `RequirementOrigin` lacks `existing-product`. *(Claude's call)* PR 7 adds them to the web app as real fields, shown read-only, so nothing lives only as a loose field.
- `versions`: the product versions the risk is introduced in or affected by. This is the local form of the web app's `releaseIds`, and import maps it.
- Levels are never stored, always derived from the matrix. The matrix lives in `config.yml` as `riskMatrix: { size: 3|5, probabilityLabels, severityLabels, cells }`. The default is the web app's `defaultMatrix(5)`. Port `src/lib/risk.ts` as is (`riskLevel`, `initialLevel`, `residualLevel`, `isMitigated`, `MITIGATION_OK`).
- Requirements get `riskIds` (the risks they mitigate), kept in sync with `mitigationIds` by the ops, as in the web app's risk ops in `src/lib/domain/ops.ts`.
- MCP tools use the web app's names exactly: `add_risks`; `update_item`, `link_items` (risk → requirement links a mitigation on both sides) and `delete_item` on risks; `search_items`/`get_item` with kind `risk`; `riskMatrix` in `get_workspace`; and `trace_code`. Like the web app, there's no unlink tool. The risk register report comes with PR 4. Port the `groundwork-risk` skill text into `skills/groundwork` and `plugins/groundwork`, covering both security and domain risks.
- `record_baseline` accepts `risks` per area, with keys linking them to the baseline's requirements as mitigations. Baseline risks get `origin: existing-product` and are scored as they are today, including residual scores where existing controls are in place.
- `validate`: an out-of-range score is an error. Mitigation ids must exist. A warning when a high risk has no mitigation.

### Tests (PR 2, both repos)

- Requirements get **`codeTests`**: `{ path, name, linkedAt, linkedBy }`, identical to the web app's `CodeTestLink`. `name` is the full name the runner reports.
- Requirements get **`testCases`**: `{ tool, id, title, url?, project?, linkedAt, linkedBy }`. `tool` is lowercase (`qase`, `testrail`, `xray`, …). `id` is a string. A case is identified by tool + project + id, ignoring case.
- **Web app change in the same PR pair:** `TestCaseLink` and `RecordedTestRun` gain `tool`, with the id as a string. Existing rows are read as `tool: "qase"`, with `caseId` → `id` and `projectCode` → `project`, through a DB migration or a read-time adapter (web app builder's call). `testStatus`/`caseOutcomes` key by tool + project + id. The gate and reports work for any tool.
- MCP tools: `link_code_tests` / `unlink_code_tests`, `link_test_cases` / `unlink_test_cases`, with the web app's names. Links made before a requirement shipped are frozen with its release, like tickets.

### CI results (PR 3)

- *(Revised while planning PR 3: results live in `results/ci/` and `results/tools/` subfolders, CI runs only on the results branch, test-tool runs in the working tree. See SPEC "Results".)*
- `groundwork results add <junit globs…> [--commit <sha>] [--ref <ref>]` parses JUnit (port `junit.ts`, `match-tests.ts`) and writes **`groundwork/results/<at>-<shortsha>.json`**: `{ id, commitSha, ref, at, source: "ci", results: [{ path, name, status }] }`. This matches the web app's `CodeRun`. Only tests linked to a requirement are kept, so files stay small. `--all` keeps every test.
- Test-management runs: MCP tool `record_test_results` (web app name) writes `groundwork/results/<at>-<tool>-<runId>.json`: `{ source: "test-tool", tool, project, id, title, url?, product, version, results: [{ id, status, endTime }], recordedAt, recordedBy, via? }`. This matches the generalised `RecordedTestRun`, recorded against a product version as the web app records it on a release.
- Reading: port `latestCodeResults` with the same `CODE_RUN_WINDOW` (30 newest default-branch runs) and `testStatus`. Only runs whose `ref` is the default branch count for code tests (`defaultBranch` in `config.yml`, defaulting to `main`).
- **Results live on a dedicated branch, `groundwork-results`** (name configurable as `resultsBranch` in `config.yml`). This works under branch protection with no bypass and doesn't retrigger CI on `main`. `results add --push` commits the file there (creating an orphan branch the first time). Readers (`check release`, `report`, `release_version`, `buildBundle`) read `groundwork/results/` from that branch with `git ls-tree`/`git show`, falling back to the working tree when the branch doesn't exist (local runs, tests). Release snapshots embed the results they used, so a snapshot never depends on the branch afterwards.
- PR 3 ships the command and the branch reading. PR 6 wires it into the Action.

### Readiness, sign-off, report (PR 4)

- Port `releaseScope`, `releaseReadiness`, `mitigationTested` and `buildReleaseSnapshot` into `src/core`. Release scope is a product version: requirements `plannedFor` / `releasedIn` it, and risks whose `versions` include it. All ten blocker types are kept with the web app's names and messages.
- `groundwork check release <version> [--product]` and MCP `check_release` print the blockers and exit 1 when there are any.
- **`release_version` runs the check.** With blockers it refuses, unless an owner (role `owner` in `config.yml`) gives `overrideJustification`. On release it writes the frozen snapshot **`groundwork/releases/<PRD-id>-<version>.json`**, the local form of the web app's `ReleaseRecord` (`releasedAt`, `releasedBy`, `overrideJustification?`, `snapshot`, with signer and approver names as of sign-off). The file is never rewritten. `correct_release` appends a correction to the product version as today, and doesn't touch the snapshot. Withdrawing a sign-off: `withdraw_release` sets `withdrawnAt/By/Reason` on the record, the web app's one allowed change.
- Baseline versions are released by `record_baseline` without blockers for missing tests (they document what exists). They still get a snapshot.
- **Snapshot shape** *(Claude's call)*: local ids and local shapes (`PRD-` ids, `REQ-`/`RSK-` ids, product version instead of a `Release` entity). The file is never rewritten. Import translates it into the web app's `ReleaseSnapshot` and also stores the original file verbatim on the record, so the exact signed record survives.
- **Versions released before this change** (e.g. `examples/acme` 1.0) have no snapshot. Nothing is generated for them locally. `check release` reports them as "released before sign-off records" and doesn't check them. On import they become a `release_records` row marked `legacy: true` with no snapshot (a web app change in PR 7), so the release stays released and locked there.
- `groundwork report release <version> --format md|csv`: built from the snapshot when one exists, otherwise live. It adds, per requirement, tasks (tickets), tests with their latest results, and the risks it mitigates, plus a risk register. Port `traceabilityRows`, `riskRegisterRows`, `toCsv`. The existing introduced/obsoleted/stakeholder-progress sections stay. CSV output is the traceability matrix, with `--table risks` for the register.

### Planning-workflow skill (PR 5)

- A skill (from the web app's `groundwork-write-requirement` and `src/lib/agent-workflow.ts`) for this loop: read the team's own document, ticket export or spreadsheet; propose stakeholder stories and solution "shall" statements with acceptance criteria, links and `origin`/`originNote`; check for duplicates against existing requirements; record them with `add_requirements` only once the team agrees. It also covers proposing risks while planning. Skill and plugin text only, no new tools unless one turns out to be needed.
- The `groundwork` and `groundwork-cloud` plugins teach the same plan → build → PR loop. Align the wording.

### Action local mode (PR 6)

- The Action gets `mode: local` (no token, no URL). On PRs it reads the trailer keys and changed paths, and posts the gap comment from the repo's own files (port `trailer.ts`, `pr-report.ts`). On the default branch it runs `groundwork results add --push`, which commits the results file to the `groundwork-results` branch with the workflow's token (needs `contents: write`, and no bypass of `main`'s protection). `fail-on-gaps` works the same in both modes.
- `merge.ts` (tagging merged work to the collecting release) has a local equivalent only if it's cheap. Otherwise it's out of scope, noted in the README.

### Migration (PR 7, both repos)

- Local `buildBundle` sends `risks`, `results` (code runs and test-tool runs), `releases` (snapshots), and product versions.
- Web app `src/lib/domain/import.ts` and `src/app/api/import/route.ts`:
  - product versions become `Release` entities;
  - `plannedFor`/`releasedIn` and risk `versions` become `releaseIds`;
  - risks keep their `RSK-` key;
  - code runs become `test_runs` rows;
  - test-tool runs go into the release's `testRuns`;
  - snapshots become `release_records`;
  - `codeTests` and `testCases` carry over as they are.
- **Keys are guaranteed.** Today the web app keeps a local key only if it's free. That changes: the import refuses when any local key (`REQ-`, `RSK-`, …) is already taken in the workspace by a different item, and lists the clashes. Nothing is written. Re-importing the same folder (same derived UUIDs) is not a clash. This keeps old `Groundwork:` trailers valid.
- Comparing blockers across repos compares type + key, not `refId` (UUIDs differ).
- *(Added while planning PR 4.)*
  - The import must not tag an obsolete requirement, or a stakeholder requirement, to a release, even if it keeps `plannedFor`. Locally neither is in a version's scope.
  - Sign-off records map to `release_records`, with the original file kept verbatim. The bundle may need to send them separately to stay under the 4 MB cap.
- The e2e test: `examples/acme` with risks, tests and results, imported into a web app test workspace. The web app's `check_release` blockers must equal the local `groundwork check release` ones.

### Wrap-up

README, SPEC (every new kind, field, folder and rule), CHANGELOG, and version 0.9.0.

## Parity

- A shared fixture (`test/fixtures/parity/`: config with matrix, requirements, risks, results) and expected outputs (levels, `isMitigated`, test status, blockers) are checked in identically in both repos and run by both test suites. Changing a ported rule means updating both repos and the fixture.
- Ported modules carry a header naming their web app source file.

## Left to the builder

- File and function layout inside `src/core` and `src/store`, and how ops thread `Collections`.
- Exact zod schemas, validation messages, MCP tool descriptions.
- Whether the web app's test-case generalisation is a DB migration or a read-time adapter.
- The results-file naming details, as long as names are unique and sort by time.
- The order of work inside each PR. Tests-first per the repo's habits.

## Verification

- `npm test` in both repos, and `groundwork validate` on `examples/acme`.
- E2E on `examples/acme`: baseline a requirement and a risk; add a mitigation requirement; link a Linear ticket, a code test and a TestRail case; `groundwork results add` a JUnit file; `groundwork check release 1.1` (exit code and blockers); `groundwork report release 1.1 --format md` and `--format csv` show each requirement's tasks, tests with results and mitigated risks; then the migration test above.
