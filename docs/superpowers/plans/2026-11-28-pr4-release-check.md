# PR 4: Release readiness, frozen sign-off, traceability report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a version goes out, Groundwork lists what blocks it (the web app's ten blocker types). Releasing it writes a frozen sign-off record. A person can print the version's traceability report from that record as Markdown or CSV: requirements, their tasks, tests with results, and the risks and mitigations.

**Architecture:**
- **Readiness.** Port the web app's pure readiness rules (`src/lib/release.ts`: risk and test blockers) into `src/core/readiness.ts`. They work on an explicit scope (requirements and risks), so the local version-based scope and the web app's release entity give the same blockers.
- **Sign-off records.** These are JSON files in `groundwork/releases/`, written once and never rewritten, except that a withdrawal is added. Each record embeds everything the report needs: the release report, the readiness result, per-requirement test outcomes, traceability rows and risk-register rows. Reports of released versions therefore never drift as files change.
- **Interfaces.** `check_release` (MCP) and `groundwork check release` (CLI, exit 1 on blockers) report readiness. `release_version` gates on it. New tools `sign_off_release` and `withdraw_release`. `groundwork report release … --format md|csv`.

**Tech Stack:** TypeScript, zod 4, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-26-local-traceability-design.md`, section "Readiness, sign-off, report (PR 4)", plus its decision on versions released before sign-off.

## Global Constraints

- Branch `release-check` in `IdeatorlabsAB/groundwork`, one PR. Never push to `main`. The user merges after CI passes. No web app changes.
- **Blocker types and messages are the web app's, word for word** (`centropic-prototype/src/lib/release.ts:59-106`): `unscored-risk`, `missing-mitigation`, `unmitigated-risk`, `unapproved-mitigation`, `untested-mitigation`, `unapproved-requirement`, `missing-tests`, `failed-code-test`, `no-ci-run`, `untested-requirement`. A `refId` is a local id. A shared fixture, `test/fixtures/parity/readiness.json` (scenario in, blocker types and messages out), pins them. The web app copy comes in PR 7.
- **Scope of a version** (product P, version V):
  - **requirements:** solution requirements of P that aren't obsolete, with `plannedFor === V` while V is planned, or `releasedIn === V` once it's released.
  - **risks:** risks of P with V in `versions`.
  - **tests:** `resultsFor(loadResults(root, config), P, V)` from PR 3. Every solution requirement in scope is tested in V, matching the web app's `testedIn`.
- **Gate.**
  - `release_version` computes readiness on the state after the release: scope `releasedIn === V`, i.e. what ships.
  - With blockers it refuses, unless the actor is an `owner` in `config.yml` and gives `overrideJustification` (1–5000 characters). That's the web app's `decideRelease`.
  - Without blockers, or with an accepted justification, it writes the record in the same call.
- **Record file:** `groundwork/releases/<PRD-id>-<slug(version)>-<n>.json`, where `n` starts at 1 and counts sign-offs of that version. A record is never overwritten. Its shape (local ids; PR 7 translates it):

```ts
interface SignOffRecord {
  schemaVersion: 1;
  kind: "release" | "baseline";
  product: { id: string; title: string };
  version: string;
  signedAt: string;
  signedOffBy: { id: string; name: string };
  /** Names of everyone the record mentions, as of sign-off. */
  people: Record<string, string>;
  overrideJustification?: string;
  matrix: RiskMatrix;
  risks: (Risk & { initialLevel: RiskLevel | null; residualLevel: RiskLevel | null; mitigated: boolean })[];
  requirements: Pick<Requirement, "id" | "title" | "kind" | "story" | "status" | "acceptanceCriteria" | "approvedBy" | "approvedAt" | "riskIds" | "stakeholderIds" | "testCases" | "codeTests" | "tickets">[];
  blockers: Blocker[];
  /** Absent for a baseline: tests weren't checked. */
  tests?: { fetchedAt: string; runs: TestRunInfo[]; codeRuns: CodeRunInfo[]; requirements: Record<string, RequirementTestStatus> };
  report: ReleaseReport;
  traceability: TraceabilityRow[];
  riskRegister: RiskRegisterRow[];
  withdrawnAt?: string;
  withdrawnBy?: string;
  withdrawReason?: string;
}
```

- **A version's active record** is its highest-numbered record that isn't withdrawn. A released version with no active record is either legacy (released before this PR) or withdrawn. `check_release` says which, and `sign_off_release` can sign it off now, with today's date.
- **Baselines.** `record_baseline` writes a `kind: "baseline"` record in the same change. Tests aren't checked, risk blockers are recorded but don't stop it, and no justification is needed. It documents what exists.
- **People:** `people` maps `config.yml` ids to names. `signedOffBy` is the actor.
- Ported files carry a header naming their web app source.

## Review Focus

1. **Requirements planned for V that didn't ship** move to another version. They aren't blockers of V and aren't in its record. Test: Task 4, `release_version judges what ships, not what moved`.
2. **An editor tries to override.** It's refused: `Only an owner can release over blockers.`, and nothing is written. Test: Task 4, `an editor can't release over blockers`.
3. **The report of a released version stays the same after its requirements change** (a later correction, a new test link, a re-scored risk), because it's read from the record. Test: Task 3, `the report of a signed-off version comes from its record, not the files`.
4. **A legacy released version** (acme 1.0, released before this PR) isn't treated as blocked. `check_release` says `released before sign-off records`, and `report` builds from live files with a header saying so. Test: Task 5, `check_release on a version released before sign-off records`.
5. **CSV a spreadsheet can't execute.** Cells starting with `= + - @` get a leading apostrophe (the web app's `toCsv`). Test: Task 3, `toCsv neutralises formulas` (ported).

---

### Task 1: Readiness rules in core

**Files:**
- Create: `src/core/readiness.ts`, porting `riskBlockers`, `testBlockers`, `verdict` and `mitigationTested` from the web app's `src/lib/release.ts`. They take a scope instead of a `Release`.
- Modify: `src/core/types.ts` (add `BlockerType` and `Blocker`, the web app's)
- Create: `test/fixtures/parity/readiness.json`, `test/readiness.test.ts`

**Interfaces** (produced):
- `interface Scope { requirements: Requirement[]; risks: Risk[] }`
- `type Tests = TestResults | null | undefined`. As in the web app: `undefined` means not checked, `null` means they couldn't be judged.
- `releaseReadiness(m: RiskMatrix, scope: Scope, all: Requirement[], tests: Tests): { ok: boolean; blockers: Blocker[] }`. `all` lets mitigations outside the scope be looked up.
- `mitigatedIn(m, risk, all, scope, tests): boolean` is `isMitigated` with the scope's test check.

Steps:
- [ ] **Step 1: Write the fixture and failing tests.** The fixture holds at least these 10 scenarios, each `{ name, matrixSize, requirements, risks, scopeIds, tests, blockers: [{ type, refId, message }] }`, with messages copied from the web app's code:
  - an unscored risk;
  - a high risk without a mitigation;
  - a high risk with a draft mitigation;
  - a residual that's still high;
  - a mitigation whose tests failed;
  - an unapproved requirement;
  - no tests;
  - a failed code test;
  - a code test not run;
  - a case not run;
  - an all-clear scenario with no blockers.

  The test `readiness matches the parity fixture` loops over it. Add `tests undefined checks no tests` and `tests null says couldn't judge`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run test/readiness.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**, together with this plan: `"Release readiness rules, ported from the web app"`.

### Task 2: Version scope and sign-off records

**Files:**
- Create: `src/store/signoff.ts`
- Modify: `src/store/validate.ts` (unreadable record files are errors, and a record whose version doesn't exist or isn't released is an error)
- Test: `test/signoff.test.ts`

**Interfaces** (`src/store/signoff.ts`):
- `RELEASES_DIR = "groundwork/releases"`
- `versionScope(state: Collections, catalogue: Catalogue, product: Product, version: string): Scope`, with the scope rule above (planned or released, from the version's status).
- `buildRecord(args: { state; catalogue; config; product; version; tests: Tests; kind; actor: string; now: string; justification?: string }): SignOffRecord`. It's pure: it calls `releaseReadiness`, `releaseReport`, `traceabilityRows` and `riskRegisterRows` (Task 3).
- `loadRecords(root): { records: (SignOffRecord & { file: string })[]; problems }`
- `activeRecord(records, productId, version)`
- `recordPath(records, productId, version): string`, the next `n`.
- `writeRecord(root, rel, record)`, which refuses to overwrite: `<rel> already exists.`
- `withdrawRecord(root, file, by, reason, now)`, which sets the three fields, refuses a record that's already withdrawn, and rewrites only that file.

Steps:
- [ ] **Step 1: Write failing tests:**
  - `versionScope of a planned version is what's planned`;
  - `versionScope of a released version is what shipped`;
  - `risks are in scope when tagged for the version`;
  - `buildRecord embeds blockers, levels, test outcomes and names`;
  - `a baseline record has no tests section`;
  - `record paths count sign-offs`;
  - `writeRecord never overwrites`;
  - `withdrawRecord records who, when and why, once`;
  - `activeRecord skips withdrawn records`;
  - `validate reports a record for a version that isn't released`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `buildRecord` needs Task 3's row functions, so stub `traceability: []` and `riskRegister: []` here, and Task 3 fills them in, with its test asserting them.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**: `"Sign-off records: version scope, build, write, withdraw"`.

### Task 3: Traceability rows, risk register, CSV, the report

**Files:**
- Create: `src/core/report-rows.ts`, porting `traceabilityRows`, `riskRegisterRows`, `toCsv`, and the `STATUS`/`LEVEL` labels from the web app's `src/lib/reports.ts`. They're adapted:
  - the rows are scoped to a version (the scope's solution requirements plus the stakeholder requirements they fulfil);
  - `releases` becomes `versions`;
  - a `tasks` column lists the linked tickets that aren't pull requests, as `<tracker> <key> (<state>)`;
  - `tests` uses the `RequirementTestStatus` passed in;
  - the risk register covers the scope's risks.
- Modify: `src/store/signoff.ts` (`buildRecord` fills `traceability` and `riskRegister`)
- Modify: `src/store/release.ts` (`renderReleaseReport(record or live)` adds three sections: "Tests" (per requirement, each test with its result and where it came from), "Risks and mitigations" (the register) and "Readiness" (blockers and the override justification), plus a header saying whether it's signed off, legacy or not released)
- Modify: `src/cli.ts` (`groundwork report release [product] <version> [--format md|csv|json] [--table traceability|risks]`)
- Test: `test/report-rows.test.ts`, `test/release-cli.test.ts`

Steps:
- [ ] **Step 1: Write failing tests:**
  - `toCsv neutralises formulas` (ported);
  - `traceabilityRows lists the version's requirements with tasks, tests and risks`;
  - `riskRegisterRows scores on the matrix labels`;
  - `the report of a signed-off version comes from its record, not the files` (sign off, then change a risk score and add a test link; `report` shows the record's values);
  - `report --format csv prints the traceability table, --table risks the register`;
  - `report on a version released before sign-off records says so`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**: `"Release traceability report from the sign-off record, in Markdown and CSV"`.

### Task 4: Gate the release, sign off, withdraw

**Files:**
- Modify: `src/mcp/server.ts`:
  - `release_version` gains `overrideJustification?`;
  - new `sign_off_release { product?, version, overrideJustification? }` and `withdraw_release { product?, version, reason }`;
  - `record_baseline` writes a baseline record.
- Modify: `src/store/release-cli.ts` or `src/cli.ts`, whichever holds `runReleaseCommand`. `groundwork release … --justification "…"`, `groundwork release <v> --sign-off [--justification]` and `groundwork release <v> --withdraw --reason "…"`.
- Test: `test/release-check-mcp.test.ts` (the `test/results-mcp.test.ts` harness), and add cases to `test/release-cli.test.ts`

**Behaviour:**
- **`release_version`** runs `releaseVersion`, then checks readiness on the new state. With blockers:
  - without a justification it refuses with `<Product> <v> isn't ready: <n> blocker(s).`, followed by one line per blocker message, and adds `An owner can release it anyway with overrideJustification.`. Nothing is written.
  - with a justification from a non-owner it refuses with `Only an owner can release over blockers.`.

  Otherwise it writes the product file, the requirements and the record in one change. The result adds `signOff: { file, blockers }`.
- **`sign_off_release`** applies to a released version with no active record (legacy or withdrawn). It uses the same gate, and its scope is `releasedIn === V`. A version that already has an active record gives `<Product> <v> is already signed off (<file>).`.
- **`withdraw_release`** is for owners only. It needs a reason and the active record, and sets the withdrawal fields. The version stays released. The result says `Sign it off again with sign_off_release once it's corrected.`.
- **`record_baseline`** writes a `kind: "baseline"` record with `tests: undefined`, after it releases the baseline version. Its blockers are recorded and nothing is refused.
- **`correct_release`** on a signed-off version still works, as it does today. Its result adds `note: "The sign-off record is frozen; withdraw it and sign off again to record the corrected release."`.

Steps:
- [ ] **Step 1: Write failing tests:**
  - `release_version releases a ready version and writes its record`;
  - `release_version refuses a version with blockers and writes nothing`;
  - `an owner releases over blockers with a justification`;
  - `an editor can't release over blockers`;
  - `release_version judges what ships, not what moved`;
  - `sign_off_release signs off a legacy released version`;
  - `withdraw_release then sign_off_release makes record 2 the active one`;
  - `record_baseline writes a baseline record`;
  - the same three in the CLI (`--justification`, `--sign-off`, `--withdraw`);
  - the tool list gains `sign_off_release`, `withdraw_release` and `check_release`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**: `"Gate releases on readiness, and record the sign-off"`.

### Task 5: `check_release` and `groundwork check release`

**Files:**
- Modify: `src/mcp/server.ts` (`check_release { product?, version }`, with the web app's description adapted to versions)
- Modify: `src/cli.ts` (`groundwork check release [product] <version> [--json]`: prints the blockers, exits 1 when there are any and 0 when ready)
- Test: `test/release-check-mcp.test.ts`, `test/release-cli.test.ts`

**Behaviour** (`check_release`):
- **Planned version:** `{ version, status: "planned", ready, blockers, tests: { runs, codeRuns, read }, scope: { requirements, risks } }` (summaries).
- **Released version with an active record:** `{ status: "signed-off", record: file, signedAt, signedOffBy, blockers (as recorded), overrideJustification? }`.
- **Released version with none:** `{ status: "released", note: "Released before sign-off records" | "Its sign-off was withdrawn", signOff: "sign_off_release" }`. In this case the CLI exits 0, prints the note and doesn't list blockers.

Steps:
- [ ] **Step 1: Write failing tests:**
  - `check_release lists a planned version's blockers`;
  - `check_release on a signed-off version reads the record`;
  - `check_release on a version released before sign-off records`;
  - `groundwork check release exits 1 with blockers and 0 when ready`;
  - `--json prints the same as check_release`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit**: `"check_release and groundwork check release"`.

### Task 6: Docs, PR

- **SPEC:**
  - "Releasing" gains readiness, the gate, owner overrides, records (path, shape, never rewritten, withdrawal), sign-off of legacy versions, and baseline records;
  - the report formats;
  - a "Readiness" block listing the ten blocker types and when each applies.
- **Skill:** the releasing steps become `check_release`, then fix or explain each blocker, then show the user, then `release_version` (with an owner's `overrideJustification` only when the user says so), then `report`. Never write a justification on someone's behalf.
- **INSTRUCTIONS:** the same, in the "Releasing a version" block.
- **README** ("Releasing" section): `groundwork check release 1.1` in CI before tagging, and `groundwork report release 1.1 --format csv > traceability.csv`.
- **CHANGELOG.**
- **Acme:** no record file. Acme 1.0 stays a legacy release, which the Review Focus 4 test uses.
- **Then:** the final review (fresh reviewer, whole branch), the fix pass, push, open the PR, watch CI.
