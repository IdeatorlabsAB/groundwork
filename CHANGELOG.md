# Changelog

## Unreleased

- **GitLab, Bitbucket and other CI.** `results add` reads the commit and branch from GitLab's and Bitbucket's own variables (`CI_COMMIT_SHA`, `CI_COMMIT_BRANCH`, `CI_DEFAULT_BRANCH`; `BITBUCKET_COMMIT`, `BITBUCKET_BRANCH`). Before, their detached checkouts meant a run on the default branch never counted as evidence. When a push is refused, the advice is for the CI it ran in.
- `groundwork ci pr --against <branch>` builds the pull request report from git: the commits since the target branch, and the files changed. `--body` adds the description, `--markdown` prints only the comment, and `--fail-on-gaps` exits 1 when there are gaps.
- Ready-to-copy pipelines in `examples/ci/` for GitLab CI and Bitbucket Pipelines. A test runs their commands.

- **A new README**, written around what Groundwork is now: traceability from requirements to the release sign-off, kept in your repository. The package and plugin descriptions say the same.
- `groundwork release <version> --withdraw --reason "…"` withdraws a sign-off from the command line (owners). On a signed-off version, the CLI's refusal names it, and messages that suggest correcting a release say to withdraw its sign-off first. Combinations that don't make sense (`--sign-off` with `--shipped` or `--correct`, `--justification` with `--correct`) are refused.
- A release, sign-off or withdrawal lists the sign-off record among the files it changed, so agents commit it.
- The report of a version released before sign-off records, or withdrawn, says its blockers weren't checked at release.
- `validate` reports a mitigation the requirement doesn't list back, and warns about a risk without a product and a test link without `linkedAt`.
- Items added together get ids in the order given. `search_items` takes `offset`, to page past 100 matches. `groundwork list` and `trace` show a risk's level.
- `results add --push` says where it recorded the run, and needs a git repository. `CI=false` isn't CI. No fetch warning before a sign-off in a repository without a remote.
- PR comments keep links to files with brackets or spaces whole, and show repository paths in a subfolder project. The Action takes `mode` in any case.
- `groundwork import` sends only CI runs from the default branch, the ones that count, so pull-request runs can't push a bundle over the size cap.

## 0.9.0

- **Risks.** A new kind, `RSK`, in `groundwork/risks/`: hazard, harm, probability and severity on a 3×3 or 5×5 matrix (`riskMatrix` in `config.yml`, 5×5 by default), residual scores, category (security or domain), and the versions it affects. Levels are derived, never stored. Same fields and rules as the Groundwork web app, so a later import carries them across.
- Mitigating requirements are linked with `link_items` from a risk to a requirement and recorded on both (`mitigationIds`, `riskIds`). `get_item` on a risk says whether it's mitigated.
- `record_baseline` records the risks an existing product carries, with the requirements that already control them.
- `trace_code` lists the requirements and risks a set of files touches, by their `codeRefs`. Agents call it before planning a change.
- A new `groundwork-risk` skill for spotting and scoring risks while planning, in a baseline, or in a risk analysis.
- **Tests, linked both ways.** Solution requirements record the automated tests that verify them (`link_code_tests`, `unlink_code_tests`: a file and the test's full name) and cases in any test-management tool, such as Qase, TestRail or Xray (`link_test_cases`, `unlink_test_cases`: tool, case id, title, project, URL). `search_items` finds requirements by test name or case id. Tests linked before a requirement shipped stay part of its release record.
- **Test results in the repository.** `groundwork results add <junit>… --push`, run in CI on the default branch, records the JUnit results of the test files your requirements link to and commits them to a `groundwork-results` branch, without touching the checked-out branch. It works in shallow single-branch checkouts and in monorepos, and retries when parallel jobs push at once. Runs from outside CI don't count as evidence.
- `record_test_results` records a test-management run (Qase, TestRail, …) for a product version, in `groundwork/results/tools/`. `get_item` on a solution requirement shows whether its tests passed, judged as the web app does.
- New `config.yml` keys `defaultBranch` and `resultsBranch`. New dependency: `fast-xml-parser`.
- **Moving to the web app keeps everything.** `groundwork import` (bundle format 2) now carries:
  - risks;
  - product versions;
  - sign-off records, verbatim;
  - the CI runs that count, and test-tool runs.

  The web app's import turns them into risks, releases, release records and test runs. Keys never change: a key another item already has is refused, not renumbered. Older web apps refuse the new format with "Update the Groundwork web app first". A contract test shared with the web app proves it judges every imported version as `groundwork check release` does.
- **The GitHub Action without an account.** `mode: local` comments on pull requests with the requirements and risks they name (`Groundwork:` trailer) or touch, and the traceability gaps, from the repository's own files. On default-branch runs it commits the JUnit results to the results branch. It runs this package's command line of the same version, outside the checkout. Cloud mode is unchanged. New command: `groundwork ci pr`.
- **Bring in your own requirements.** A new `groundwork-write-requirement` skill: the web app's rules for writing stakeholder and solution requirements, and a workflow for turning the team's own documents, tender texts, tickets and spreadsheets into Groundwork requirements. It inventories the source first, rewrites in batches with the exact source place in `originNote`, checks duplicates and records each batch once the team agrees. `search_items` now finds requirements by their source reference.
- The `groundwork` skill teaches the same plan → build → PR loop as the web app's agents, including the `Groundwork:` trailer and `check_release` when opening a PR. The `groundwork-cloud` plugin's skills are refreshed from the web app, and a test checks that every tool and field a skill names exists.
- **Breaking: releasing now checks readiness.** A version whose requirements have no linked tests, or whose tests haven't passed, is refused until the tests are linked and their results recorded, or an owner releases it with `--justification` (MCP: `overrideJustification`). Teams that release without tests today need an owner for each release until they add them.
- **Release readiness and sign-off.**
  - `check_release` and `groundwork check release <version>` list what blocks a version, using the web app's rules and messages: unmitigated or unscored risks, unapproved requirements, and tests that are missing, failed or haven't run. The CLI exits 1 when anything does.
  - Releasing signs the version off in a frozen record in `groundwork/releases/`. With blockers, only an owner can release, with a written justification.
  - A signed-off version can't change until an owner withdraws the sign-off (`withdraw_release`). `sign_off_release` signs off versions released before records, and baselines once all their areas are in.
  - Drafts planned for a version now move on when it's released.
- **Traceability report.** `groundwork report release <version>` (`--json` prints the same release report as before, plus `signOff`) adds each requirement's tasks, tests and results, the risks and mitigations, and readiness, read from the sign-off record. `--format csv` gives the traceability table, and `--table risks` the risk register.
- `groundwork import` refuses a folder with risks or test results until the web app's import carries them, so nothing is dropped.
- Needs Node.js 22 or newer. Node 20 reached end of life in April 2026, and CI no longer tests it.

## 0.8.0

- **Reverse-engineer a baseline.** An agent can read an existing codebase and record what it does as an approved, already released baseline, so a modernization starts with a requirement repository. The skill walks through it: survey, product areas, a draft per area, a check with you, then record.
- `record_baseline` records one product area per call: inferred hypotheses, and stakeholder and solution requirements approved by a named person. The solution requirements are released in the baseline version, which is created if it's missing. It refuses a version with other planned or shipped work, and it needs product files.
- New origin `existing-product` for requirements. Hypotheses take `origin: inferred` and an `originNote`. Requirements and hypotheses take `codeRefs`, links to the code (a path, with an optional `#symbol` or `:line`). `validate` warns when a path doesn't exist, and doesn't ask inferred hypotheses for insights.
- The release report of an all-baseline version is a "baseline report" with a count per area.
- New needs and changes in a modernization get new requirements with `replaces: [baseline id]`. Baseline items are never edited.

## 0.7.0

- **Tickets, linked both ways.** Solution requirements record the tickets that implement them, in any tracker: `link_tickets`, `unlink_tickets`, and `update_tickets` to refresh status. Agents link the tickets they create from requirements, and fix tickets to the requirement they restore. `search_items` finds requirements by ticket key. The web app's single Linear issue (`delivery`) is shown as a ticket.
- **Release readiness from tickets.** `get_release` sorts planned requirements into `ready` (all tickets done), `notReady` and `noTickets`. Agents propose `ready` as shipped and ask about the rest.
- The release report lists each introduced requirement's tickets, as linked when the version was released. A ticket linked before its requirement shipped can't be unlinked.

- **Releasing.**
  - `release_version` (and `groundwork release <version> --shipped …`) releases a planned version and records who and when. Planned requirements that didn't ship move to a version you name. Replaced requirements become obsolete once all their replacements have shipped, and planned removals are confirmed.
  - `get_release` shows what's planned for a version, or its report once released.
  - `release_requirements` adds requirements that shipped later to a released version.
  - `correct_release` (and `groundwork release <version> --correct --reason …`) corrects a released version, with the reason recorded on the version.
- **Release report.** `groundwork report release <version>` prints, as Markdown, what a version introduced, what it made obsolete, how far each stakeholder need is met, and any corrections. Use it in release documentation, e.g. EU MDR technical documentation.
- `get_item` on a stakeholder requirement shows its progress: how many of its solution requirements are released, and the version it was fully met in.
- New fields: `madeObsoleteBy` on requirements (who made it obsolete; `obsoletedBy` still holds the replacing requirements), and `corrections` on product versions.
- The acme example releases 1.0.

- **Versions on requirements.** Approving a solution requirement plans it for a planned version of its product: `approve_requirement` takes `plannedFor`, which is required once the product has planned versions. `plan_requirements` moves approved requirements to another planned version.
- **Replacements wait for the release.** A requirement can name what it `replaces`. When it's approved for a version, the old requirements stay valid, with `obsoletePlannedFor` set to that version, and move with it if it's re-planned. Without versions, the old ones become obsolete on approval, as before.
- `obsolete_requirement` takes `inVersion`, to remove a requirement in a planned version. A requirement that has shipped needs it.
- `validate` checks version references against the product: unknown versions, `releasedIn` on an unreleased version, approved solution requirements with no planned version, and versions on stakeholder requirements.
- New optional requirement fields: `replaces`, `plannedFor`, `obsoletePlannedFor`, and `releasedIn`, `releasedAt`, `releasedBy` and `obsoletedIn` (for releasing, coming next). None of them can be changed with `update_item`.

## 0.6.0

- **Product catalogue.** Each product is a file in `groundwork/products/` (`PRD-0001-…md`) holding its areas and versions, kept in the repo next to the code. Area ids are unique across products. A solution requirement's `product` is the product id.
- `add_products` creates product files. `add_product_areas` adds areas to one, and the new `add_product_versions` adds planned versions. `get_workspace` returns each product with its areas and versions.
- `groundwork migrate [--dry-run]` moves a project's products and areas from `config.yml` into product files and points requirements at product ids. Projects that haven't migrated keep working as before.
- `validate` checks area ids across products, duplicate versions, and requirements that name a product by title instead of id.
- `renumber` covers product files and requirements' `product` links.
- `migrate` also finishes a migration that stopped half-way, and points free-text product names in older projects at product files added later.
- **Breaking:** `config.yml` is now `schemaVersion: 2` for new projects, after `migrate`, and when the first product file is added to an older project. Older groundwork-mcp versions refuse such a folder and say to update. New `config.yml` files no longer include the old `productAreas` / `products` lists.

## 0.5.0

- `groundwork validate --against <base>` also reports ids that the branch shares with a different item on the base branch. Everyone numbers new items on their own clone, so two branches can both create `REQ-0012`.
- `groundwork renumber --against <base>` fixes this on the branch. The branch's items get the next free ids, their files are renamed, and links to them are rewritten in the files the branch changed. Ids on the base never change. Notes that mention an old id are reported, not rewritten.
- The duplicate-id error points at `renumber`. The README's CI example checks against the base branch.

## 0.4.0

- Requirements in two layers. Stakeholder requirements are user stories ("As a … I want … so that …"). Solution requirements are "shall" statements, and each must fulfil at least one stakeholder requirement through `stakeholderIds`. The tools refuse a solution requirement without one, and won't delete the only stakeholder requirement a solution requirement fulfils.
- `add_requirements` and `update_item` return `warnings` when a story doesn't fit its layer. `get_item` on a stakeholder requirement lists the solution requirements that fulfil it (`fulfilledBy`).
- `validate` reports an active solution requirement without stakeholder links as an error. It warns about stakeholder requirements that nothing fulfils yet, and about wording.
- Requirements no longer need `findingIds` or an `origin`, so they can be written before building.
- **Breaking:** `add_requirements` requires `kind`. Existing solution requirements without `stakeholderIds` now fail `groundwork validate`. Link them to a stakeholder requirement with `link_items`.
- The acme example now has a stakeholder requirement behind every solution requirement.
- When agents plan work, they classify the task as a new need, a change or a fix, and state that in the plan. For a new need or a change, they record requirements before writing code, and they build tickets from requirements with the REQ ids in them.
- Recording insights, hypotheses, experiment results or requirements directly isn't planning work, so agents record what a product manager asks for without the new need / change / fix call.
- `approve_requirement` can record an approval given outside Groundwork, such as a PM approving verbally. It takes `approvedBy` and a `note`, and stores who entered it as `recordedBy`.
- Setup instructions for Codex in the README, the skill and the CLI's messages (`--help`, `init`, `import`).

## 0.3.0

- `add_product_areas` and `add_products`: agents can add product areas and products to `config.yml`. Add-only: existing ones are skipped.
- `add_requirements` matches a product name regardless of case and stores the spelling from `config.yml`.

## 0.2.0

- `groundwork import --to <web app>`: move a project into the Groundwork web app. Checks the files first, supports `--dry-run`, and is safe to run again (items already there are skipped unless `--overwrite`). Afterwards `config.yml` says `migrated:`, and local tools only read.

## 0.1.0

First release.

- Local MCP server (`groundwork-mcp`) with 17 tools to read, add, link and update insights, hypotheses, experiments, findings and requirements, run experiments and the requirement approval flow.
- Items stored as Markdown files with YAML frontmatter under `groundwork/`, with readable ids (`INS-0001`). See SPEC.md.
- `groundwork` CLI: `init`, `validate`, `trace`, `list`, `mcp`.
- Claude Code plugin with a skill.
