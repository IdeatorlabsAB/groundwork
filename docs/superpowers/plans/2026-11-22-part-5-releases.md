# Part 5: Releasing versions, corrections and the release report. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team releases a product version, either from ticket status or by hand, and gets one dated, auditable
record of what that version introduced and made obsolete. A released version can be corrected with a recorded
reason, and a Markdown release report can go into compliance documentation (e.g. EU MDR technical documentation).

**Architecture:**
- The release rules are pure functions in `src/store/release.ts`. They take requirements, a product and a version,
  and return new requirements, a new product and a report. The MCP tools and the CLI both call them.
- The MCP `write()` wrapper gains an optional `products` result, so one tool call can save item files and a
  product file together.
- The report is plain data, rendered to Markdown by `renderReleaseReport`.

**Tech Stack:** TypeScript, zod 4, the `yaml` package, @modelcontextprotocol/sdk, vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-product-catalogue-releases-design.md`. The parts that apply:
- "Releasing";
- "Release report";
- "Stakeholder requirements are derived";
- "Answered by the user after the builder check" (corrections);
- "Who and when, per requirement";
- "Obsolescence follows its replacement";
- "Anti-goals".

## Global Constraints

- **Only solution requirements belong to releases.** A stakeholder requirement's release state is derived, never
  stored.
- A requirement "in" version V of product P means: a solution requirement whose product is P (per `productOf`),
  with status approved or in-delivery, `plannedFor: V` and no `releasedIn`.
- **Releasing V:**
  - Shipped requirements get `releasedIn: V`, `releasedAt`, `releasedBy` (the acting person).
  - Requirements planned for V but not listed as shipped must move to `moveTo`, a different planned version of P.
    Without `moveTo` the release is refused and the leftovers are listed. Nothing is dropped silently.
  - **Obsolescence:**
    - A requirement replaced by others (`obsoletedBy` set) becomes obsolete in V only when all of its
      replacements are released, counting this release.
    - Otherwise its `obsoletePlannedFor` moves to the latest planned version among its unreleased replacements.
    - A planned removal (`obsoletePlannedFor: V` with no `obsoletedBy`) must be confirmed in `removed`, or it moves
      to `moveTo` like a leftover.
  - **Becoming obsolete** sets `status: obsolete`, `obsoletedIn: V`, `obsoletedAt`, and
    **`madeObsoleteBy`** (the person).
    - The design calls that field `obsoletedBy`, but that name already holds the replacing requirement ids. That
      meaning stays, and the person goes in the new field.
  - The version gets `status: released`, `releasedAt`, `releasedBy`.
- **Corrections:**
  - Only on a released version, and `reason` is required.
  - They change only what they list; there's no cascading. To undo a shipped replacement and its old
    requirement's obsolescence, list both.
  - Each one is appended to the version's `corrections: [{ at, by, reason, shipped: { added, removed }, obsolete: { added, removed }, movedTo? }]`.
- **Who can release:** owners and editors. Viewers are refused by the existing `refusal()` check in the server; the
  CLI adds the same check with `resolveActor`.
- **Releasing is never undone silently.** There's no "un-release": a correction is the only way to change a
  released version.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A release that lists a requirement not planned for V, or a `moveTo` that isn't a planned version of P (or is V
   itself): refused, with nothing written.
2. A requirement with two replacements, only one of which ships in V: it stays valid, and its `obsoletePlannedFor`
   moves to the other's version.
3. Releasing a version that's already released: refused, pointing at `correct_release` and `release_requirements`.
4. The report of a version with a correction: the correction shows in its own section, with reason, who and when.
   The introduced and made-obsolete lists reflect the corrected state.
5. A stakeholder requirement whose solution requirements ship across two versions: `get_item` and the report say
   "2 of 3 released" after the first, and "fully met in <second>" after the second.

---

### Task 1: Release rules

**Files:**
- Create: `src/store/release.ts`
- Modify: `src/core/types.ts` (`Requirement.madeObsoleteBy?: string`)
- Modify: `src/store/products.ts` (`ProductVersion.corrections?: Correction[]`, and the zod `corrections` array,
  loose)
- Test: `test/release.test.ts` (new)

**Interfaces:**
- Produces, in `src/store/release.ts`:
  - `interface Correction { at: string; by: string; reason: string; shipped: { added: string[]; removed: string[] }; obsolete: { added: string[]; removed: string[] }; movedTo?: string }`
  - `class ReleaseError extends Error`
  - `interface ReleaseInput { product: Product; version: string; shipped: string[]; removed?: string[]; moveTo?: string; actor: string; now: string }`
  - `pendingRelease(requirements: Requirement[], product: Product, version: string, catalogue: Catalogue): { planned: Requirement[]; replacedBy: Requirement[]; removals: Requirement[] }`.
    `replacedBy` holds the requirements whose `obsoletePlannedFor` is V and that have `obsoletedBy`; `removals`
    holds those with no `obsoletedBy`.
  - `releaseVersion(requirements: Requirement[], catalogue: Catalogue, input: ReleaseInput): { requirements: Requirement[]; product: Product }`.
    It throws `ReleaseError` for:
    - an unknown version, or one already released;
    - a shipped id not in `planned`, or a removed id not in `removals`;
    - leftovers without `moveTo`;
    - a `moveTo` that isn't a planned version of the product other than V.
  - `releaseRequirements(requirements: Requirement[], catalogue: Catalogue, input: { product: Product; version: string; ids: string[]; actor: string; now: string }): Requirement[]`.
    For an already released version: the ids must be approved or in-delivery solution requirements of that
    product, not released yet. The same obsolescence rule applies to what they replace.
  - `correctRelease(requirements: Requirement[], catalogue: Catalogue, input: { product: Product; version: string; reason: string; addShipped?: string[]; removeShipped?: string[]; addObsolete?: string[]; removeObsolete?: string[]; moveTo?: string; actor: string; now: string }): { requirements: Requirement[]; product: Product }`.
    - Removing from shipped clears `releasedIn`, `releasedAt` and `releasedBy`, and sets `plannedFor: moveTo`.
      `moveTo` is required, and must be a planned version.
    - Removing from obsolete sets status `approved`, clears `obsoletedIn`, `obsoletedAt` and `madeObsoleteBy`, and
      sets `obsoletePlannedFor: moveTo`.
    - Adding to obsolete requires an approved requirement, and makes it obsolete in V.
    - Adding to shipped follows the `releaseRequirements` rule.
    - An empty `reason` throws.

- [ ] **Step 1: Write the failing tests** in `test/release.test.ts`. They are pure: no files. Build a `Catalogue`
  with `catalogueOf(config, [product])`, where the product `PRD-0001` has versions `1.0`, `1.1` and `1.2`, all
  planned. Use a `req(id, extra)` factory for solution requirements with `product: PRD-0001` and status approved.
  - Release 1.0 with `shipped: [A]` while A and B are planned → throws `B … moveTo`. With `moveTo: "1.1"` →
    A has `releasedIn: "1.0"`, `releasedBy: "sam"`; B has `plannedFor: "1.1"`; the version is released, with
    `releasedAt` and `releasedBy`.
  - Old O replaced by R (`R.replaces: [O]`, `O.obsoletePlannedFor: "1.0"`, `O.obsoletedBy: [R]`), and R ships in
    1.0 → O has status obsolete, `obsoletedIn: "1.0"`, `madeObsoleteBy: "sam"`.
  - O replaced by R1 (1.0) and R2 (1.1), and only R1 ships in 1.0 → O stays approved, with
    `obsoletePlannedFor: "1.1"`.
  - A removal X (`obsoletePlannedFor: "1.0"`, no `obsoletedBy`):
    - in `removed` → obsolete in 1.0;
    - not in `removed` and no `moveTo` → throws;
    - with `moveTo: "1.1"` → `obsoletePlannedFor: "1.1"`.
  - Errors:
    - a shipped id not planned for 1.0;
    - `moveTo: "1.0"`;
    - `moveTo: "9.9"`;
    - releasing 1.0 twice → `already released … correct_release or release_requirements`.
  - `releaseRequirements` on released 1.0 for C (planned for 1.1) → C has `releasedIn: "1.0"`. On planned 1.1 →
    throws `not released yet`.
  - `correctRelease`:
    - remove A from 1.0 with `moveTo: "1.1"` and a reason → A is back to `plannedFor: "1.1"` with no `releasedIn`,
      and the version's `corrections[0]` matches `{ by: "sam", reason, shipped: { added: [], removed: [A] }, movedTo: "1.1" }`;
    - an empty reason → throws.
- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/release.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `release.ts` and the two type additions.** Version order for "latest planned version" is
  the product's list order, the same rule as `laterVersion` in the server. Move that helper into `release.ts` as
  `laterVersion(product, a, b)` and use it from the server too.
- [ ] **Step 4: Run them and the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `Release rules: release a version, release single requirements, correct a release`.

### Task 2: Release report and stakeholder progress

**Files:**
- Modify: `src/store/release.ts`
- Modify: `src/mcp/server.ts` (`get_item` on a stakeholder requirement)
- Test: `test/release.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Produces:
  - `interface StakeholderProgress { id: string; title: string; released: number; total: number; fullyMetIn?: string }`:
    counted over the requirement's active and obsolete solution requirements that were released. `total` counts
    the active ones plus those released and later made obsolete.
  - `stakeholderProgress(requirements: Requirement[], stakeholderId: string, catalogue: Catalogue): StakeholderProgress`.
    `fullyMetIn` is the latest `releasedIn` (by product version order) once every active fulfilling requirement is
    released.
  - `interface ReleaseReport { product: { id: string; title: string }; version: ProductVersion; introduced: { id: string; title: string; story: string; tickets: unknown[]; stakeholders: { id: string; title: string }[] }[]; madeObsolete: { id: string; title: string; replacedBy: { id: string; title: string }[] }[]; stakeholders: (StakeholderProgress & { inThisVersion: "fully met" | "partly met" })[]; corrections: Correction[] }`.
    `tickets` is the requirement's `tickets` field if present; tickets come in part 6.
  - `releaseReport(requirements: Requirement[], catalogue: Catalogue, product: Product, version: string): ReleaseReport`
  - `renderReleaseReport(r: ReleaseReport): string`: Markdown.
    - Title: `# <product> <version>: release report`.
    - A line with the release date and who released it.
    - Sections: `## Introduced`, `## Made obsolete`, `## Stakeholder requirements`, `## Corrections` (omitted when
      there are none).
    - Each requirement line: `- **REQ-0012** <title>: <story>`, followed by its stakeholders.
- `get_item` on a stakeholder requirement adds `progress: StakeholderProgress`.

- [ ] **Step 1: Write the failing tests:**
  - A stakeholder S has solutions A (1.0), B (1.0) and C (1.1). After releasing 1.0 with A and B,
    `stakeholderProgress` gives `{ released: 2, total: 3 }` with no `fullyMetIn`. After releasing 1.1 with C, it
    gives `fullyMetIn: "1.1"`.
  - `releaseReport` for 1.0 lists A and B under introduced, each with S, and S as "partly met".
  - A report after a correction includes it under corrections. The removed requirement isn't in introduced.
  - `renderReleaseReport` contains `# Clinicare Web Application 1.0: release report`, `## Introduced`,
    `- **A** `, and `## Corrections` only when there are corrections.
  - MCP: `get_item` on a stakeholder requirement returns `progress`.
- [ ] **Step 2: Run them and check they fail**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `Release report and stakeholder progress`.

### Task 3: MCP release tools

**Files:**
- Modify: `src/mcp/server.ts`
  - `write()`: `fn` may also return `products?: Product[]`, which are saved with `writeProduct(root, p, s.loaded.paths.get(p.id))` after `save()`.
  - New tools: `get_release`, `release_version`, `release_requirements`, `correct_release`.
  - `INSTRUCTIONS`: a "Releasing" block.
- Modify: `skills/groundwork/SKILL.md`: a "Releasing" section, and a row in the "When to reach for it" table.
- Test: `test/mcp.test.ts` (also add the four tools to the tool list test)

**Interfaces:**
- Consumes: `pendingRelease`, `releaseVersion`, `releaseRequirements`, `correctRelease`, `releaseReport` and
  `ReleaseError` from Tasks 1–2. `ReleaseError` maps to a tool error.
- **`get_release({ product?, version })`** (read-only):
  - for a planned version: `{ status: "planned", planned: summaries with tickets, obsoleteWhenReleased: { replaced: …, removals: … } }`;
  - for a released version: `{ status: "released", report }`.
  - `product` defaults to the only product.
- **`release_version({ product?, version, shipped: REQ[], removed?: REQ[], moveTo? })`:** the actor is
  `s.actor.id`. The result is the release report.
- **`release_requirements({ product?, version, ids })`** and **`correct_release({ product?, version, reason, addShipped?, removeShipped?, addObsolete?, removeObsolete?, moveTo? })`:**
  the result is the updated report.
- **The "Releasing" guidance**, in `INSTRUCTIONS` and the skill:
  1. Call `get_release` for the version.
  2. If the workflow has a tracker tool, check each planned requirement's tickets. Propose `shipped` as the
     requirements whose tickets are all done. Without a tracker, ask the user which requirements shipped.
  3. Show the user the list, and where the rest will move. Release only once they agree.
  4. For a mistake in a released version, use `correct_release` with the user's reason. Never edit the files.

- [ ] **Step 1: Write the failing MCP tests**, in a `describe("releasing")`:
  - Setup: a product with 1.0 and 1.1 planned; stakeholder S; solutions A and B, approved for 1.0.
  - `get_release` for 1.0 lists A and B.
  - `release_version` with `shipped: [A]` and no `moveTo` → an error naming B. With `moveTo: "1.1"` → the result
    report lists A. The product file shows 1.0 released with `releasedBy: "sam"`. B's file has `plannedFor: "1.1"`.
  - `get_release` for 1.0 now returns the report.
  - `release_version` for 1.0 again → an error mentioning `correct_release`.
  - `correct_release` without a reason → schema error. With a reason, removing A to 1.1 → the product file has a
    correction.
  - A viewer gets the viewer refusal.
- [ ] **Step 2: Run them and check they fail**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `MCP release tools: get_release, release_version, release_requirements, correct_release`.

### Task 4: CLI, example and docs

**Files:**
- Create: `src/release-cli.ts`. It exports `runReleaseCommand(root: string, args: { product?: string; version: string; shipped?: string[]; removed?: string[]; moveRest?: string; correct?: boolean; reason?: string; add?: string[]; remove?: string[]; addObsolete?: string[]; removeObsolete?: string[] }): { code: number; lines: string[] }`
  and `runReportCommand(root: string, args: { product?: string; version: string; json?: boolean }): { code: number; lines: string[] }`.
  The CLI prints `lines`, and the tests call these directly, because CI runs the tests before the build.
- Modify: `src/cli.ts`
  - `groundwork release <product> <version> --shipped A,B [--removed C] [--move-rest V]`;
  - `groundwork release <product> <version> --correct --reason "…" [--add A] [--remove B] [--add-obsolete C] [--remove-obsolete D] [--move-rest V]`;
  - `groundwork report release <product> <version> [--json]`.

  `<product>` is a product id or title, and can be left out when there's one product: then the args are just
  `<version>`. A viewer (per `resolveActor`) gets `Viewers can't release.` and exit 1. A `ReleaseError` prints in
  red and exits 1.
- Modify: `examples/acme/groundwork/`. Release acme 1.0 with REQ-0002 shipped, using the CLI itself, after the
  build. Use `GROUNDWORK_USER=sam`.
- Docs:
  - `README.md`: a "Releasing" section with the CLI, the agent prompt *"Release Clinicare 1.0"*, and a short
    sample of the report;
  - `SPEC.md`: the version `corrections`, requirement `madeObsoleteBy`, and the release rules;
  - `CHANGELOG.md`: under Unreleased.
- Modify: `.github/workflows/ci.yml`: after the existing `validate` step on `examples/acme`, add
  `node ../../dist/cli.js report release 1.0`, so the built CLI runs on a real release.
- Test: `test/release-cli.test.ts` (new). It calls `runReleaseCommand` and `runReportCommand` on a temp copy of
  `examples/acme`, with `process.env.GROUNDWORK_USER` set per test.

- [ ] **Step 1: Write the failing CLI tests:**
  - On a copy of acme (1.0 planned, REQ-0002 planned for 1.0): `release 1.0 --shipped REQ-0002` exits 0.
  - `report release 1.0` then prints `# Acme app 1.0: release report` and `REQ-0002`.
  - A second `release 1.0` exits 1, and its output mentions `--correct`.
  - `GROUNDWORK_USER=viewer`, with a viewer added to the config → exit 1 and `Viewers can't release.`
- [ ] **Step 2: Build, run them, and check they fail**

Run: `npx vitest run test/release-cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the CLI commands. Release acme 1.0 with the built CLI. Write the docs.**
- [ ] **Step 4: Check**

Run: `npm run build && npm test && npm run typecheck && (cd examples/acme && node ../../dist/cli.js validate && node ../../dist/cli.js report release 1.0)`
Expected: green, valid, and the report printed.

- [ ] **Step 5: Commit** with the message `CLI release and report; acme releases 1.0; document releasing`.
