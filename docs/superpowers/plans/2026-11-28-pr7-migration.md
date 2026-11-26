# PR 7: Migrate everything into the web app (both repos) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `groundwork import --to <web app>` carries every local artefact across with nothing lost and the same keys: requirements (including the baseline), risks with mitigations and scores, tickets, code tests and test-management cases, CI and test-tool results, and product versions with their sign-off records.

**Done means** an end-to-end test: `examples/acme`, with risks, tests, results, a signed-off version, a legacy version and a planned one, is bundled by the local import, planned by the web app's `planImport`, and then judged by the web app's `releaseReadiness`. The web app's blockers must equal the local `groundwork check release` ones (type + key) for every version.

**Architecture:**
- **Local (`groundwork`, branch `migrate-all`).** `buildBundle` drops its refusals and sends, under bundle `schemaVersion: 2`:
  - risks;
  - product versions;
  - sign-off records (each verbatim);
  - code runs: the CI window (the newest 30 counting runs) plus every run a record cites;
  - test-tool runs.

  A contract test builds a deterministic bundle from a prepared copy of acme and writes it, with the expected local readiness of every version, to `test/fixtures/web-app-contract.json`. The test fails when the committed file is stale; `UPDATE_CONTRACT=1` rewrites it.
- **Web app (`centropic-prototype`, branch `import-all`).** `bundleSchema` takes versions 1 and 2. `planImport` returns `{ items, records, codeRuns, ... }` as before, now with risks and releases, and the route inserts `release_records` and `test_runs` rows. The contract fixture is copied byte for byte into the web app's tests, and its e2e test checks the plan's readiness against the expected blockers.

**Spec:** `docs/superpowers/specs/2026-11-26-local-traceability-design.md`, section "Migration (PR 7, both repos)" and its notes added during PRs 3 and 4.

## Global Constraints

- Two branches and two PRs. The user merges after CI passes, the web app's first. Until it's in, today's web app refuses a version 2 bundle (`schemaVersion: literal(1)`), with a clear error and no loss.
- **Ids.** Every local item, version and record gets a UUID derived from the workspace and a stable name. This is the existing `uuidV5(ws, "groundwork:<id>")`, plus `groundwork:release:<PRD>:<version>` and `groundwork:record:<file>`. Re-importing the same folder therefore finds the same rows.
- **Keys are guaranteed.** Before writing anything, the import refuses when any local key (`REQ-`, `RSK-`, …) is already the key of a different item in the workspace. It lists up to 20 clashes and writes nothing. Re-importing the same folder (same derived UUIDs) is not a clash.
- **Mapping:**
  - **Risks** keep every field. `product` becomes the product title. `versions` becomes `releaseIds`. `owner` is mapped to a member, and `category`, `domain`, `origin` and `originNote` are kept.
  - **The web app's types gain:** `Risk.category?`, `Risk.domain?`, `Risk.origin?: "existing-product"`, `Risk.originNote?`, and `existing-product` in `RequirementOrigin`. The risk page shows category and domain read-only.
  - **Product versions** become `Release` entities: `name` is the version, `product` the product title, `targetDate` the planned date. `testRuns` holds that version's test-tool runs, mapped to `RecordedTestRun`, with `recordedBy` mapped to a member.
  - **Requirements:** a live solution requirement gets `releaseIds = [release(releasedIn ?? plannedFor)]`. Obsolete and stakeholder requirements get none (both are outside the local version scope). `riskIds`, `codeTests`, `testCases` and `tickets` carry over. `linkedBy`, `approvedBy`, `approver` and `releasedBy` are mapped to members, with the originals kept under `imported.people`.
  - **CI runs** become `test_runs` rows `{ workspace_id, commit_sha, ref, default_branch, created_at: at, results, totals }`, for `source: "ci"` runs only. The id is derived. Rows already there are skipped. A `commitSha` that doesn't match `^[0-9a-f]{7,40}$` is skipped with a warning.
  - **Active sign-off records** become `release_records` rows:
    - `release_id`, `released_at: signedAt`, `released_by` (member);
    - `override_justification`;
    - `snapshot`: the record translated into a `ReleaseSnapshot` (ids mapped, `release` the Release entity, `signedOffBy` and `people` as recorded), plus `snapshot.local`, the original record verbatim.
  - **Withdrawn records** are inserted withdrawn: `withdrawn_at`, `withdrawn_by` (member), `withdrawn_by_name`, `withdraw_reason`.
  - **A released version with no active record** (released before sign-off records) gets a row whose snapshot is `{ legacy: true, release, matrix, risks: [], requirements: [], blockers: [] }` and `released_at` the version's `releasedAt`. It's marked, not verified. The report page shows "Released before sign-off records" for it.
  - Records are immutable, so a release that already has a record is left alone, with a warning when the local one differs.
- **Size.** The bundle stays under the 4 MB cap. The CI window and cited runs bound the runs; records are sent whole. Over 4 MB the import refuses, as today.
- **After import,** the local folder is marked `migrated:` as today, and local tools only read.

## Review Focus

1. **Blockers match between the repos** for every version in the contract fixture: planned, signed-off and legacy. Test: web app `test/import-contract.test.ts`, `the web app judges each imported version as groundwork check release did`.
2. **Re-importing the same folder** creates nothing twice: items, releases, test runs and records. Test: web app `import is idempotent, records and test runs included`.
3. **A key clash** with an existing workspace item is refused, and nothing is written. Test: web app `refuses a local key another item already has`.
4. **A legacy release** imports as released and locked, without claiming verification. Test: web app `a version released before sign-off records imports as a legacy record`.
5. **The old web app refuses a version 2 bundle** cleanly. A version 1 bundle from an older groundwork-mcp still imports. Test: web app `still imports a version 1 bundle`.

---

### Task 1 (local): Send everything

**Files:**
- Modify: `src/store/import.ts`. Remove the risk and result refusals. Add `items.risks`, `versions`, `records`, `codeRuns` and `testRuns`, at bundle `schemaVersion: 2`. Requirements keep the local product id as `productId`, beside the title in `product`.
- Modify: `test/import.test.ts`. Drop the setup that strips risks and results. Add:
  - `bundles risks, versions, records, CI runs and test-tool runs`;
  - `sends the CI window and the runs records cite`;
  - `local runs aren't sent`.
- Create: `test/web-app-contract.test.ts`. It:
  1. builds a copy of acme with fixed times and actor;
  2. approves REQ-0003 for 1.1 and links the existing code test and case;
  3. writes a passing CI run and a failing TestRail run for 1.1;
  4. adds a version 1.2 with a planned requirement and a high risk without mitigation;
  5. releases 1.1 with an owner's justification, which writes its record;
  6. leaves 1.0 as it is (legacy).

  It then writes `test/fixtures/web-app-contract.json` as `{ bundle, expected: { [version]: { status, blockers: [{ type, key }] } } }` from `buildBundle` and `checkRelease`. It compares with the committed file, or writes it under `UPDATE_CONTRACT=1`.
- Commit, with this plan: `"Import: send risks, versions, sign-off records and results"`.

### Task 2 (web app): Types and the plan

**Files:**
- Modify: `src/lib/types.ts` (the Risk fields and the origin, as above)
- Modify: `src/lib/domain/import.ts`:
  - `bundleSchema` takes schemaVersion `1 | 2`, with `items.risks`, `versions`, `records`, `codeRuns` and `testRuns` optional;
  - the STORED risk schema;
  - `planImport` adds risks and releases to `items`, and returns `records: ReleaseRecordRow[]` and `codeRuns: TestRunRow[]`;
  - the key-clash refusal;
  - the people mapping for the new fields.
- Create: `src/lib/domain/import-records.ts`, with `snapshotFromLocal(record, maps): ReleaseSnapshot` and `legacySnapshot(release, matrix)`.
- Tests: `test/import.test.ts`. Add:
  - `imports risks with their mitigations, scores and versions as releases`;
  - `refuses a local key another item already has`;
  - `still imports a version 1 bundle`;
  - `a version released before sign-off records imports as a legacy record`;
  - `withdrawn records import withdrawn`;
  - `import is idempotent, records and test runs included`.
- Create: `test/import-contract.test.ts` and `test/fixtures/web-app-contract.json` (copied). `the web app judges each imported version as groundwork check release did`:
  - **planned versions:** `releaseReadiness(matrix, release, items, releaseTests(release, codeRuns))` gives the expected `type + key` pairs;
  - **signed-off versions:** the record snapshot's blockers do;
  - **legacy versions:** no blockers, marked legacy.

Commit: `"Import: risks, releases, sign-off records and test runs from groundwork files"`.

### Task 3 (web app): The route, the report page, the risk page

**Files:**
- Modify: `src/app/api/import/route.ts`. After `commit`, insert `plan.records` into `release_records` and `plan.codeRuns` into `test_runs`, with `upsert` on id and `ignoreDuplicates`. The report adds `records` and `testRuns` counts. Dry runs count without writing.
- Modify: `src/app/app/releases/[id]/report/page.tsx`. A `snapshot.legacy` record renders a banner: "Released before sign-off records: imported from groundwork files, not verified at release." No tables.
- Modify: the risk detail UI (wherever hazard and harm are shown): category and domain, read-only.
- Verify: `npm test && npx tsc --noEmit && npm run lint`. Commit.

### Task 4: Docs, reviews, PRs

- **Local:** README "Moving to the Groundwork web app" says what migrates. CHANGELOG. SPEC import section.
- **Web app:** no user docs beyond the risk and report page text.
- **Then:** a final review of both branches (a fresh reviewer, run end to end: local bundle → web app `planImport` → readiness), the fix pass, push, two PRs cross-linked, watch CI.

---

## Revisions after the plan review (they override the tasks above)

1. **The e2e test judges every version from scratch in the web app.** The contract's `expected[version].blockers` is the local `releaseReadiness(matrix, versionScope(...), all, resultsFor(...))` for every version, signed-off ones included (not `checkRelease`, which returns the record).
   - The web app test recomputes `releaseReadiness(matrix, release, items, releaseTests(release, codeRunWindow(rows)))` for every imported release and compares `type + key`.
   - `codeRunWindow(rows)` is a pure function pulled out of `loadCodeRuns`: default branch only, newest `created_at` first, 30 runs. Both use it.
   - Version 1.2 gets a requirement with a code test and a case, and runs that pass the code test and fail the case.
2. **Only an owner can import sign-off records.** When the bundle has records (active, withdrawn, or released versions that become legacy rows) and the importer isn't an owner, the import refuses: "This folder has signed-off releases; a workspace owner must run the import." Nothing is written.
3. **Write order and safety.**
   - Releases that already have an active record in the workspace are passed into `planImport` and skipped, with a count.
   - Writes go: workspace settings, `commit`, `test_runs`, then `release_records`. Each is idempotent through derived ids, so re-running finishes a partial import.
   - A failure after `commit` returns 500 "Partly saved: run the import again to finish it." The plan is the same whether or not items were skipped.
   - A single-transaction RPC is out of scope: it would need a new security-definer migration in production.
4. **Keys.** The pre-check refuses known clashes. After `commit`, the keys the database assigned (the `SavedKeys` from commit) are compared with the wanted ones, and any renumbered key is reported as a warning naming it. The race can't be rolled back without the RPC, so it's reported honestly.
5. **Scope:**
   - a requirement's product is `productOf(catalogue, r)` (the only product when it has none), sent as `product`;
   - obsolete requirements with `releasedIn` are tagged to that release, and only obsolete ones that were merely planned are untagged;
   - `versions` or `plannedFor` values with no matching product version are dropped, with a warning;
   - an existing web app release with the same product and name is reused instead of creating a second.
6. **Legacy rows.** `ReleaseSnapshot.legacy?: true`, with derived id `groundwork:record:legacy:<PRD>:<version>`. The release page, the releases list and MCP `check_release`/`get_item` say "Released before sign-off records (imported)", not "Signed off by …".
7. **`overwrite`** never replaces a release in `releasedIds`, or items tagged to one.
8. **Workspace CI.** The report warns when the workspace already has `test_runs`, because they mix into the window.
9. **Caps.** `.max()` on `records` (200), `codeRuns` (300) and `testRuns` (500). The local `runImport` turns a 400 about `schemaVersion` into "Update the Groundwork web app first: it doesn't take this folder's format yet."
10. **Fixture drift.** Both repos' contract tests assert the fixture's sha256 against a constant. Regenerating it locally (`UPDATE_CONTRACT=1`) changes the hash and fails the web app's test until the fixture is copied and the constant updated.

**Cut:**
- runs cited by records beyond the window;
- the "local record differs" warning (replaced by a "left alone" count);
- the risk page's category and domain UI (the fields are stored and typed).
