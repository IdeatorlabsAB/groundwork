# Groundwork file format, version 2

This is the contract between your files, the `groundwork` tools and anything else that reads them, including the Groundwork web app's importer. Everything lives in one folder, `groundwork/`, at the root of your project.

```
groundwork/
  config.yml
  products/PRD-0001-clinicare-web-application.md
  insights/INS-0001-setup-takes-too-long.md
  hypotheses/HYP-0001-guided-import.md
  experiments/EXP-0001-guided-import-pilot.md
  findings/FND-0001-guided-import-lifts-activation.md
  requirements/REQ-0001-guided-csv-import.md
  risks/RSK-0001-invoice-sent-to-wrong-patient.md
```

## Items

Each item is one Markdown file: YAML frontmatter between `---` lines, then an optional body.

```markdown
---
id: INS-0001
title: Setup takes too long
quote: I gave up on the import after twenty minutes.
source: interview
persona: Ops lead
participant: P07
tags: [onboarding]
sentiment: negative
productArea: onboarding
createdAt: 2026-11-18T10:00:00.000Z
createdBy: sam
---

Anything you write here is yours. Groundwork reads it as the item's `notes` and never rewrites it.
```

- **Ids** are a kind prefix and a number of at least four digits: `INS`, `HYP`, `EXP`, `FND`, `REQ`, `RSK`. They never change, and an id is never reused within its kind. New items get one more than the highest id of their kind. Two branches can therefore give the same id to different items. The same id at a different file path is a different item. `groundwork validate --against <base>` reports this, and `groundwork renumber --against <base>` fixes it on the branch: the branch's item gets the next free id, its file is renamed (the slug stays), and links to it are rewritten in the files the branch added or changed. Ids on the base never change, and Markdown bodies are never rewritten.
- **File names** are `<id>-<slug>.md`. Only the id matters; the slug comes from the title at creation and stays when the title changes, so links to the file don't break. A file has to be in the folder for its kind.
- **Links** are lists of ids in fields such as `insightIds`. They point from an item to the evidence it builds on.
- **Unknown fields** are kept. Tools may add fields in later versions.
- **Times** are ISO 8601 strings. **People** are ids from `config.yml`.

### Fields by kind

Required fields are in bold.

**Insight** (`insights/`, `INS-`): evidence from a real person.
**`title`**, **`quote`** (what they said or did, verbatim), **`source`** (`interview` | `support` | `survey` | `analytics` | `observation`), **`persona`** (a role, never a name), `participant` (a reference such as P07), `tags`, `sentiment` (`negative` | `neutral` | `positive`), `productArea`, `createdAt`, `createdBy`.

**Hypothesis** (`hypotheses/`, `HYP-`): "We believe we will [outcome] if [forWhom] get [benefit] with [feature]."
**`title`**, **`outcome`**, **`forWhom`**, **`benefit`**, **`feature`**, **`status`** (`draft` | `testing` | `validated` | `invalidated`), `insightIds`, `successMetric` (`name`, `unit`, `baseline`, `target`, `direction`: `increase` | `decrease`, `timeframe`), `guardrail`, `knowWhen`, `alternatives`, `edge`, `riskiestAssumption`, `confidence` (0–100), `priority`, `origin` (`inferred`: reverse-engineered from an existing product, not stated by anyone) and `originNote` (what it was inferred from), `codeRefs`, `productArea`, `owner`, `createdAt`, `updatedAt`.

**Experiment** (`experiments/`, `EXP-`): tests exactly one hypothesis.
**`title`**, **`hypothesisId`**, **`method`** (`pilot` | `ab-test` | `prototype-test` | `survey` | `fake-door` | `concierge`), **`description`**, **`primaryMetric`** (`name`, `unit`, `baseline`, `target`, `direction`, and `actual` once measured), **`status`** (`planned` | `running` | `completed`), `guardrails` (metrics that must not get worse), `sampleSize`, `durationWeeks`, `startDate`, `endDate`, `resultNotes`, `verdict` (`validated` | `invalidated` | `inconclusive`), `checkBackDate`, `owner`.

**Finding** (`findings/`, `FND-`): what was learned.
**`title`**, **`summary`**, `experimentIds`, `hypothesisIds`, `insightIds`, `confidence` (`low` | `medium` | `high`), `productArea`, `createdAt`.

**Requirement** (`requirements/`, `REQ-`): what is needed before building, in two layers.
**`title`**, **`kind`** (`stakeholder` | `solution`; files without it are read as `solution`), **`story`**, **`acceptanceCriteria`** (a list), **`status`** (`draft` | `awaiting-approval` | `approved` | `in-delivery` | `obsolete`), `stakeholder` (stakeholder requirements: who has the need), `stakeholderIds` (solution requirements: **required**, the stakeholder requirements it fulfils), `product` (solution requirements), `priority` (`must` | `should` | `could`), `findingIds`, `insightIds`, `hypothesisIds`, `origin` (`tender` | `regulation` | `contract` | `customer-need` | `existing-product`) and `originNote`, `codeRefs` (where the behaviour lives: a repo-relative path, optionally with `#symbol` or `:line`, up to 50), `approver`, `approvedBy`, `approvedAt`, `recordedBy` (who entered an approval given by someone else), `approvalNote`, `replaces` (approved requirements this one replaces), `plannedFor`, `releasedIn`, `releasedAt`, `releasedBy`, `obsoletePlannedFor`, `obsoletedIn` (solution requirements only, versions of its product; see below), `obsoletedBy`, `obsoletedAt`, `madeObsoleteBy` (the person who made it obsolete), `tickets` (solution requirements; see below), `productArea`, `createdAt`, `updatedAt`.

`codeTests` and `testCases` (solution requirements; see "Tests" below): the tests that verify it.

`riskIds` (set by the tools): the risks this requirement mitigates. It mirrors each risk's `mitigationIds`.

**Risk** (`risks/`, `RSK-`): what could go wrong with the product, for the people who use it or depend on it.
**`title`**, **`hazard`** (what could go wrong, and why), **`harm`** (who gets hurt, and how), **`probability`** and **`severity`** (whole numbers from 1 to the matrix size, before mitigation), `residualProbability` and `residualSeverity` (once the mitigations are in place), `mitigationIds` (the requirements that control it), `product` (a product id), `versions` (versions of its product it's introduced in or affects), `category` (`security` | `domain`), `domain` (for domain risks, e.g. `patient-safety`, `financial`), `owner`, `codeRefs`, `origin` (`existing-product`) and `originNote`, `productArea`, `createdAt`, `updatedAt`.

The two layers:

- A **stakeholder requirement** says who needs what and why. Its `story` is a user story: "As a medical secretary I want a view of the calendars of all practitioners in the clinic with their unbooked slots highlighted so that I can find them and book appointments easily."
- A **solution requirement** describes the qualities and behaviour the solution must have to meet stakeholder needs. Its `story` is one or more "shall" statements: "The appointment view used by medical secretaries shall show the calendars of the selected practitioners with the free slots highlighted. It shall be possible to click a free slot to start the booking flow. It shall be possible to add or remove practitioners in the view."
- Every active solution requirement fulfils at least one stakeholder requirement (`stakeholderIds`). A stakeholder requirement is fulfilled by one or more solution requirements.

`findingIds`, `insightIds`, `hypothesisIds` and `origin` are optional: link them when the requirement rests on evidence or comes from a tender, regulation or contract.

### Links

| From | Field | To |
|---|---|---|
| hypothesis | `insightIds` | insights |
| experiment | `hypothesisId` | one hypothesis |
| finding | `experimentIds`, `hypothesisIds`, `insightIds` | experiments, hypotheses, insights |
| requirement | `findingIds`, `insightIds`, `hypothesisIds` | findings, insights, hypotheses |
| solution requirement | `stakeholderIds` | stakeholder requirements |
| requirement | `obsoletedBy` | the requirements that replaced it |
| requirement | `replaces` | the approved requirements it replaces |
| risk | `mitigationIds` | the requirements that mitigate it |
| requirement | `riskIds` | the risks it mitigates (the same links, seen from the requirement) |

### Rules the tools apply

These rules live in the core library, so every Groundwork tool applies them the same way.

- Starting an experiment moves a `draft` hypothesis to `testing`.
- Recording results computes the verdict. It is **validated** when the primary metric reaches its target (`actual >= target` for `increase`, `<=` for `decrease`) and every guardrail holds. It is **invalidated** when either fails. The hypothesis moves to the same status.
- New hypotheses, findings and requirements without a `productArea` take the most common one among their linked evidence.
- A solution requirement can't be saved without at least one stakeholder requirement in `stakeholderIds`, and a stakeholder requirement can't have any. A stakeholder requirement can't be deleted while it is the only one a solution requirement fulfils. `validate` reports an active solution requirement without stakeholder links as an error.
- `validate` warns about an active stakeholder requirement that no solution requirement fulfils yet, and about a `story` that doesn't fit its layer: a stakeholder story without "As a … I want … so that …", or a solution requirement without "shall". The tools save these and return the same warnings.
- An approval given outside Groundwork (e.g. verbally) can be recorded with `approvedBy` and an optional note; the person recording it is stored as `recordedBy`.
- **Versions.** A solution requirement's version fields name versions of its product (its `product`, or the only product):
  - approving it plans it for a planned version (`plannedFor`), which is required once the product has planned versions;
  - `plan_requirements` moves it to another planned version until it ships;
  - `releasedIn` (with `releasedAt` and `releasedBy`) and `obsoletedIn` are set by the release step.

  None of these can be changed with `update_item`. Stakeholder requirements have no versions: which versions meet them follows from the solution requirements that fulfil them.
- **Replacing.**
  - A requirement can name what it `replaces`: approved requirements only, because drafts are updated in place.
  - When it's approved for a version, the old ones stay approved and valid, with `obsoletePlannedFor` set to that version and `obsoletedBy` set to the new one. They become obsolete when that version is released. If the replacement moves to another version, they move with it.
  - Without versions, the old ones become obsolete when the replacement is approved.
  - `obsolete_requirement` with `inVersion` plans the same for a requirement removed without a replacement. Without `inVersion`, it applies straight away, which is only allowed before the requirement has shipped.
- **Releasing.**
  - Releasing a planned version sets `releasedIn`, `releasedAt` and `releasedBy` on the solution requirements that shipped, and `status: released`, `releasedAt` and `releasedBy` on the version.
  - Planned requirements that didn't ship, and planned removals that weren't confirmed, move to another planned version, which must be given. A released version can't be released again.
  - A replaced requirement becomes obsolete in the version where the last of its replacements ships (`status: obsolete`, `obsoletedIn`, `obsoletedAt`, `madeObsoleteBy`).
  - Requirements that shipped later can be added to a released version.
  - Any other change to a released version is a correction: it needs a reason, changes only what it lists, and is recorded on the version.
  - The release report lists what a version introduced, what it made obsolete, how far each stakeholder requirement is met as of that version, and its corrections. It also lists each requirement's tests and results, the risks and mitigations, and the readiness blockers.
- **Readiness.** A version's scope is its solution requirements (the live ones planned for it, or every one that shipped in it once it's released, even if obsolete since) and the risks tagged for it. It's blocked by the web app's ten blocker types:
  - for each high risk:
    - `missing-mitigation`: no mitigating requirement;
    - `unapproved-mitigation`: a mitigation that isn't approved or in delivery;
    - `unmitigated-risk`: a residual score that's still high or not scored;
    - `untested-mitigation`: a mitigation in the version whose tests didn't pass;
  - for any risk, `unscored-risk`: a score the matrix can't place;
  - `unapproved-requirement`: a requirement in scope that isn't approved;
  - for each solution requirement in scope:
    - `missing-tests`: nothing linked;
    - `failed-code-test`;
    - `no-ci-run`: a code test with no default-branch CI result, or one that was skipped;
    - `untested-requirement`: a case whose latest result in the version's runs didn't pass.

  `check_release` and `groundwork check release` list them. The CLI exits 1 when there are any. Both read CI results as last fetched, and never fetch themselves.
- **Sign-off.** Releasing a version signs it off. It's judged on what ships: requirements moved to another version don't count. Drafts planned for it move too.
  - **With blockers,** only an owner (`role: owner` in config.yml) can release it, giving `overrideJustification`. That's a convention, not access control: the person acting is whoever `$GROUNDWORK_USER` or git's email says.
  - **Fresh results.** The results branch is fetched first. When that fails, it's read as last fetched, and the record says so.
  - **The record** is `groundwork/releases/<PRD-id>-<version>-<n>.json`, holding:
    - the version's requirements, the stakeholder requirements they fulfil, and the mitigations of its risks;
    - the risks with their levels;
    - the matrix, the blockers, the test outcomes (with the results commit read), the release report, who signed it off, and everyone's names.

    It's never rewritten, except to add a withdrawal (`withdrawnAt`, `withdrawnBy`, `withdrawReason`). The version gets `signOff: <record file>`.
  - **A signed-off version is frozen.** `release_requirements` and `correct_release` refuse it until an owner withdraws the sign-off (`withdraw_release`). `sign_off_release` then signs it off again as record `n + 1`.
  - **Versions with no sign-off.** `sign_off_release` also signs off a version released before sign-off records, and a baseline once its last area is recorded. A baseline's tests aren't checked, and its blockers are recorded but don't stop it.
  - **`validate` reports:**
    - a record that can't be read;
    - a record for a version that isn't released, or that's misnamed;
    - two active records for one version, e.g. from two branches;
    - a `signOff` whose file is missing.
  - **`renumber`** rewrites ids in records that are new on the branch.
- **Reports.** `groundwork report release <version>` builds the report from the active record, so it never changes. A version with no record is built from the current files, with a header saying so. Formats:
  - Markdown (the default);
  - `--format csv`, the traceability table: key, title, kind, status, statement, fulfils, risks, versions, tasks, tests, pull requests, code;
  - `--format csv --table risks`, the risk register;
  - `--json`, the release report as JSON, with `signOff` naming the record it came from.

  CSV cells that a spreadsheet would run as formulas are prefixed with an apostrophe.
- **Baseline.** `record_baseline` documents what an existing product already does, one product area per call.
  - It adds inferred hypotheses (`origin: inferred`, status `validated`) and stakeholder and solution requirements (`origin: existing-product`), approved by a named approver who isn't a viewer. Keys link the new items to each other.
  - The solution requirements are planned for the baseline version and released in it, in the same change. A missing version is created as the oldest one.
  - It refuses a planned version that has other planned work, a released version holding requirements that aren't baseline, `findingIds` and `replaces`. It needs product files, not a legacy catalogue.
  - It warns when a title matches a requirement already in the area.
  - A release report of a version that holds only baseline requirements is called a baseline report and counts requirements per area.
- **Code references.** `validate` warns `codeRefs: <path> doesn't exist` when the path of a code reference isn't in the repository. Inferred hypotheses aren't asked for insights.
- **Tests.** A solution requirement lists the tests that verify it.
  - `codeTests`: automated tests in the repository, `{ path, name, linkedAt, linkedBy }`. `path` is repo-relative (no `..`, no leading `/`). `name` is the full name the test runner reports, so CI results can be matched on path and name. A test is identified by path and name.
  - `testCases`: cases in any test-management tool, `{ tool, id, title, project?, url?, linkedAt, linkedBy }`. `tool` is lowercase (`qase`, `testrail`, `xray`, …). `id` is the case id as the tool shows it, as text. A case is identified by tool, project and id, ignoring case, so the same number in two tools or two projects is two cases.
  - Tests are linked with `link_code_tests` and `link_test_cases`, and unlinked with `unlink_code_tests` and `unlink_test_cases`. Linking a case again refreshes its title and url and keeps when it was first linked.
  - Only solution requirements that aren't obsolete take tests. A test linked before its requirement shipped (`linkedAt` up to `releasedAt`) is part of that release's record and can't be unlinked.
  - `validate` reports tests without the fields that identify them, and tests on a stakeholder requirement, as errors. It warns about a code test whose file doesn't exist and a case linked twice.
- **Tickets.** A solution requirement's `tickets` lists the tickets that implement it, in any tracker: `{ tracker, key, url?, title?, state?, done?, linkedAt, linkedBy, syncedAt? }`.
  - `tracker` is lowercase (`linear`, `jira`, `github`, …). A ticket is identified by tracker and key, ignoring case.
  - `state` is the tracker's own status name, and `done` says whether it's finished.
  - Tickets are linked and unlinked only with `link_tickets` and `unlink_tickets`. `update_tickets` refreshes `state` and `done` everywhere a ticket is linked.
  - A ticket linked before its requirement shipped is part of that release's record and can't be unlinked. A release report lists only the tickets linked by the time the version was released.
  - The web app's single Linear issue (`delivery`) is read as a ticket.
- **Risks.**
  - A risk's level (`low`, `medium`, `high`) is never stored. It's read from the matrix in `config.yml` (`riskMatrix`) at `cells[probability - 1][severity - 1]`, for the initial and the residual score.
  - A risk that isn't high is acceptable as it is. A high risk is mitigated when its residual score is no longer high and every mitigating requirement exists and is `approved` or `in-delivery`.
  - Mitigations are linked with `link_items` from the risk to the requirement, and recorded on both (`mitigationIds`, `riskIds`). A released requirement can be linked: the risk register isn't part of a requirement's release record. Deleting either side removes the link.
  - `versions` names versions of the risk's product. Only planned versions can be added or removed. A risk's product can't change once it's tagged for versions.
  - `validate` reports scores outside the matrix, unknown mitigations, products and versions, and a `riskIds` entry the risk doesn't list back, as errors. It warns about a high risk without a mitigation.
  - `record_baseline` takes the risks an existing product carries: `origin: existing-product`, tagged for the baseline version, with `mitigationKeys` (keys of the call's solution requirements) and `mitigationIds` for the controls it already has.
- Requirements go from `draft` to `awaiting-approval` (with an `approver`) to `approved`. The approver can send one back to `draft`. Only `approved` requirements can become `obsolete`.
- Deleting an item removes links to it. Deleting a hypothesis also deletes its experiments.

## Products

Each product is a file in `products/`, prefix `PRD`, following the same file rules as items (frontmatter, the id never changes, the slug is fixed at creation, the body is yours).

```yaml
id: PRD-0001
title: Clinicare Web Application
areas:
  - { id: scheduling, label: Scheduling }
versions:
  - { version: "1.0", status: planned, plannedFor: 2027-03-01 }
createdAt: 2026-11-22T10:00:00.000Z
```

- **`areas`**: `id` (lowercase letters, digits and dashes) and `label`. Area ids are unique across all products in the folder, so an item's `productArea` points to exactly one product.
- **`versions`**: in release order (the list order; no semver rules). `version` is unique within its product, and `(product id, version)` is its permanent key, so a version string isn't renamed once anything refers to it. `status` is `planned` or `released`. `plannedFor` is an optional target date. `releasedAt` and `releasedBy` are set when the version is released. `corrections` lists the corrections made to a released version: `{ at, by, reason, shipped: { added, removed }, obsolete: { added, removed }, movedTo? }`.
- A solution requirement's `product` is a product id (`PRD-0001`).

`add_products` creates product files. `add_product_areas` and `add_product_versions` add to one; they need the product when there's more than one. All three are add-only: they skip entries already there and never rename, reorder or remove anything. Rename or remove by editing the file.

## Results

Test results are JSON files under `groundwork/results/`. Their shapes match the Groundwork web app's, so a later import carries them across.

**CI runs** (`results/ci/<YYYYMMDDTHHMMSSZ>-<sha7>-<job>.json`), written by `groundwork results add`:

```json
{ "id": "…uuid…", "commitSha": "abc1234…", "ref": "refs/heads/main", "at": "2026-11-27T10:15:00.000Z",
  "source": "ci", "defaultBranch": true, "totals": { "passed": 41, "failed": 1, "skipped": 2 },
  "results": [{ "path": "test/billing.test.ts", "name": "billing > REQ-0042 totals match", "status": "passed", "durationMs": 12 }] }
```

- `results` holds every result in the test files that a linked code test points to, so a file's newest run is its current set of tests. `totals` counts the whole report.
- `<job>` is `<run id>-<attempt>-<job>-<random>` in GitHub Actions, otherwise random, so matrix legs and re-runs never overwrite each other.
- `source` is `ci` when written in CI (`$CI` set), otherwise `local`. `defaultBranch` says whether `ref` was the repository's default branch when the run was written (from GitHub's event file, else `defaultBranch` in config.yml).
- With `--push`, the file is committed only to the results branch (`resultsBranch`, default `groundwork-results`), on top of its tip and without touching the checked-out branch. A push that loses a race with another job is redone, up to 5 times; one the server declines (a ruleset, a hook) isn't. Files are created relative to the repository root, so `groundwork/` can sit in a subfolder.

**Test-tool runs** (`results/tools/<tool>-<project>-<run>-<hash>.json`), written by `record_test_results` in the working tree and committed with the work:

```json
{ "source": "test-tool", "tool": "testrail", "project": "", "id": "R3", "title": "1.1 regression", "url": "…",
  "product": "PRD-0001", "version": "1.1",
  "results": [{ "id": "C101", "status": "passed", "endTime": "2026-11-27T10:00:00Z" }],
  "recordedAt": "…", "recordedBy": "sam" }
```

The name is fixed by tool, project and run id, so recording the same run again replaces it. Statuses are `passed`, `failed`, `blocked`, `skipped`, `invalid` and `in_progress`; the agent maps its tool's own statuses to them.

**From the GitHub Action.** With `mode: local`, the Groundwork Action runs `groundwork results add --push` on default-branch runs. On pull requests it runs `groundwork ci pr`, which prints the PR report as JSON: the requirements and risks the PR names in its `Groundwork:` trailer (`Groundwork: REQ-0042, RSK-0007`, in the description or a commit message) or touches through `codeRefs`, and the gaps. The gaps are:
- a named solution requirement without tests;
- an approved requirement whose code changed without being named;
- a high risk without mitigation;
- with the PR's JUnit reports, named requirements whose linked tests failed or didn't run.

**Reading.** Tools read CI runs from `origin/<resultsBranch>` as last fetched (never fetching themselves) and from the working tree, the branch winning on a name clash, and test-tool runs from the working tree. Only the newest 30 CI runs that count (CI, default branch) are read; files that don't count don't take their place.

**Judging a requirement's tests** (the web app's rules):
- A code test counts its result in the newest CI run that has it, among runs with `source: ci` and `defaultBranch: true`. A test missing from a newer run of its file was deleted or renamed and stops counting.
- A case counts its latest finished result (by `endTime`) across the test-tool runs recorded for the version, matched by tool, project and id.
- A requirement passes when every linked test passed. Failed, blocked and invalid count as failed. Skipped, in progress and missing count as not run.

`get_item` on a solution requirement shows this for the version it shipped in or is planned for. `validate` warns about result files it can't read.

## config.yml

```yaml
schemaVersion: 2
name: Clinicare
people:
  - id: sam            # used in createdBy, owner, approver
    name: Sam
    role: owner        # owner | editor | viewer
    email: sam@acme.example   # optional: matched against `git config user.email`
defaultBranch: main     # optional: the branch whose CI runs count
resultsBranch: groundwork-results   # optional: where CI commits result files
riskMatrix:             # optional; leave out for the 5×5 default
  size: 3                # 3 or 5
  probabilityLabels: [Low, Medium, High]
  severityLabels: [Low, Medium, High]
  cells:                 # cells[p - 1][s - 1]: low | medium | high
    - [low, low, medium]
    - [low, medium, high]
    - [medium, high, high]
migrated: https://…    # set by the web app importer (groundwork import); local writes stop
```

The default 5×5 matrix labels probability Rare, Unlikely, Possible, Likely, Almost certain and severity Negligible, Minor, Moderate, Major, Catastrophic. A score p × s of 15 or more is high, 5 or more is medium, the rest low. The 3×3 default: 6 or more is high, 3 or more medium.

**Version 1 folders** keep areas and products as flat lists in `config.yml` (`productAreas: [{ id, label }]`, `products: [names]`), and a requirement's `product` is a name. Tools keep reading and writing them that way. `groundwork migrate` moves them to product files: each product name becomes a product, all areas go to the first one (it says so when there are several), requirements get product ids, and the lists are removed from `config.yml`, which gets `schemaVersion: 2`. Nothing migrates implicitly; the first product file in a folder without lists also sets `schemaVersion: 2`. If lists are left in a version 2 `config.yml`, they're ignored and `validate` warns.

The person acting is `$GROUNDWORK_USER` (a person id). Otherwise it's the person whose `email` matches git's, or the only person listed. If none of those apply, it's `me`.

## Versioning

`schemaVersion` changes only for changes that would break older readers. Version 2 moved products into `products/`. Tools refuse to write a version newer than they understand. Adding optional fields doesn't change the version.

## Moving to the web app

`groundwork import --to <web app>` sends the whole folder as one bundle (`format: groundwork-files`, `schemaVersion: 2`):
- `items`: insights, hypotheses, experiments, findings, requirements and risks. A requirement's and a risk's `product` is the product's title, with `productId` beside it.
- `versions`: every product version, with `productId` and the product's title.
- `records`: the sign-off records, as they are in `groundwork/releases/`, each with its `file`.
- `codeRuns`: the CI runs that count (`source: ci`, the newest window).
- `testRuns`: the test-tool runs, with `productId` and the product's title.

How the web app reads it:
- **Ids.** Each local item, version and record gets an id derived from the workspace and its local name, so importing again finds the same rows.
- **Keys.** Local ids become keys unchanged. A key another item already has refuses the import.
- **Versions** become releases, matched by product and name. A requirement is tagged to the release it shipped in, or the one it's planned for while it's live. A risk is tagged to its `versions`.
- **Sign-offs.**
  - Each sign-off record becomes a release record, withdrawn ones withdrawn, with the original kept verbatim.
  - A released version without a record becomes a legacy release record: locked, marked as never verified.
  - Only an owner can import released versions.
