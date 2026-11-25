# Reverse-engineer a baseline: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can read a legacy codebase and record its behaviour as an approved, shipped baseline in Groundwork: stakeholder and solution requirements plus the inferred original hypotheses, each pointing at the code. It does this with one `record_baseline` call per product area.

**Architecture:**
- Additive schema fields: requirement origin `existing-product`, `codeRefs` on requirements and hypotheses, and hypothesis `origin: "inferred"`.
- A new store module `src/store/baseline.ts` composes the existing ops (`addHypotheses`, `createRequirement`) and the release functions (`releaseVersion`, `releaseRequirements`) into one atomic change.
- The MCP tool validates inputs with the same Session checks as `add_requirements`, then calls it.
- `validate` warns about `codeRefs` paths that don't exist. The release report labels baseline versions and counts them per area.

**Tech Stack:** TypeScript, zod 4, @modelcontextprotocol/sdk, vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-reverse-engineer-baseline-design.md`

## Global Constraints

- New requirement origin value: exactly `"existing-product"`. New hypothesis origin value: exactly `"inferred"`.
- `codeRefs`: optional `string[]`, max 50 entries, each a trimmed 1–300 character string. Form: a repo-relative path, optionally followed by `#symbol` or `:line`.
- All schema changes are additive and optional. Existing files and the hosted web app's import must keep working unchanged.
- Baseline items are created already approved (requirements) and `validated` (hypotheses), and their solution requirements are released into the named version.
- `record_baseline` is all or nothing: any refusal leaves the workspace unchanged.
- Version bump: `package.json` to `0.8.0`, with a CHANGELOG entry.
- Copy style: plain words, short sentences, matching the existing SKILL.md and tool descriptions.

## Review Focus

- **A re-run for an area already recorded.** Expect a warning naming the existing requirement with the same title in that area, not silent duplicates. Pinned in Task 4 (`warns on a title already in the baseline area`).
- **A baseline version that already has non-baseline requirements planned for it** (e.g. the team planned "1.0" and the user names it as the baseline). Expect a refusal naming them, with nothing changed. Pinned in Task 3.
- **`approvedBy` that isn't in `config.yml` people.** Expect a refusal, as in `approve_requirement`. Pinned in Task 4.
- **A legacy catalogue (products still in `config.yml`).** Expect the same "Run groundwork migrate first" refusal as `add_product_versions`. Pinned in Task 4.
- **A `codeRefs` entry with `#symbol` or `:line`, or a directory path.** Only the path part is checked, and an existing directory counts as present. Pinned in Task 2.

---

### Task 1: Schema fields

**Files:**
- Modify: `src/core/schemas.ts` (`REQUIREMENT_ORIGIN`, `hypothesisInput`, `requirementInput`, `PATCHES`)
- Modify: `src/core/types.ts` (`RequirementOrigin`, `Requirement`, `Hypothesis`, new `HypothesisOrigin`)
- Test: `test/mcp.test.ts`

**Interfaces:**
- Produces:
  - `REQUIREMENT_ORIGIN = z.enum(["tender","regulation","contract","customer-need","existing-product"])`
  - `HYPOTHESIS_ORIGIN = z.enum(["inferred"])` (exported)
  - a `codeRefs` zod helper: `z.array(z.string().trim().min(1).max(300)).max(50).optional()`, with a description stating the path form
  - `Requirement.codeRefs?: string[]`, `Hypothesis.codeRefs?: string[]`, `Hypothesis.origin?: HypothesisOrigin`, `Hypothesis.originNote?: string`
- `hypothesisInput` gets `codeRefs`, `origin` and `originNote` (`z.string().trim().max(300).optional()`). `requirementInput` gets `codeRefs`. `PATCHES` inherit them through `.partial()`; nothing else to do there.

- [ ] **Step 1: Write the failing test** in `test/mcp.test.ts`. Name it `"stores codeRefs and the existing-product origin"`. It calls `add_requirements` with a stakeholder requirement carrying `origin: "existing-product"` and `codeRefs: ["src/billing/invoice.ts#applyDiscount"]`, then `add_hypotheses` with `origin: "inferred"` and `codeRefs: ["src/billing"]`. Assert that the result isn't an error, and that `load(root)` returns both items with those exact `codeRefs` and `origin` values.
- [ ] **Step 2: Run it.** `npx vitest run test/mcp.test.ts -t "codeRefs"`. Expected: FAIL (zod rejects the unknown origin or the extra keys).
- [ ] **Step 3: Implement the fields above.** Check that the file schemas in `src/store/validate.ts` (built from these inputs with `.loose()`) accept them. If the hypothesis file schema isn't derived from `hypothesisInput`, add the fields there too.
- [ ] **Step 4: Run** `npx vitest run`. Expected: all PASS, including existing tests.
- [ ] **Step 5: Commit** with the message `Add codeRefs and existing-product / inferred origins`.

### Task 2: Validate `codeRefs` and inferred hypotheses

**Files:**
- Modify: `src/store/validate.ts`
- Modify: `src/cli.ts:91` and `src/mcp/server.ts:459` (pass the root)
- Test: `test/mcp.test.ts` (it already imports `validate`, `load` and a temp `root`)

**Interfaces:**
- Produces: `validate(loaded: Loaded, config: Config, opts?: { root?: string }): Problem[]`. Without `root`, `codeRefs` aren't checked (the hosted app and existing callers are unaffected).

- [ ] **Step 1: Write failing tests:**
  - `"warns about codeRefs paths that don't exist"`: create `src/a.ts` and the directory `src/lib/` under `root`. Add a requirement with `codeRefs: ["src/a.ts#fn", "src/a.ts:12", "src/lib", "src/gone.ts"]`. Expect exactly one warning on that requirement's file, whose message contains `codeRefs: src/gone.ts doesn't exist`. Expect no problems that mention `src/a.ts` or `src/lib`.
  - `"doesn't ask for insights on an inferred hypothesis"`: a hypothesis with `origin: "inferred"` and no `insightIds` produces no `no insights linked` warning. Without `origin`, it still does.
- [ ] **Step 2: Run** `npx vitest run test/mcp.test.ts -t "codeRefs|inferred"`. Expected: FAIL.
- [ ] **Step 3: Implement.** For requirements and hypotheses, strip each entry at the first `#`, or a trailing `:\d+`, and check `existsSync(join(opts.root, path))`. Use the message `` `codeRefs: ${path} doesn't exist` `` at level `warning`. Skip the insights warning when `item.origin === "inferred"`. Pass `root` from both callers.
- [ ] **Step 4: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** with the message `validate: check codeRefs paths, accept inferred hypotheses`.

### Task 3: `recordBaseline` store function

**Files:**
- Create: `src/store/baseline.ts`
- Test: `test/baseline.test.ts` (style of `test/release.test.ts`: in-memory `Requirement`s, `product()`, `cat()`, a fixed `NOW`; use `emptyCollections()` and `ctx()` from `test/fixtures.ts`)

**Interfaces:**
- Consumes: `ops.addHypotheses`, `ops.createRequirement`, and `Ctx`/`Change` from `src/core/ops.ts`; `releaseVersion`, `releaseRequirements` and `ReleaseError` from `src/store/release.ts`; `Catalogue` and `catalogueOf`.
- Produces:
```ts
export interface BaselineInput {
  product: Product;               // resolved by the caller
  version: string;
  approvedBy: string;             // person id, already checked by the caller
  note?: string;                  // approval note; default "Recorded as the as-is baseline"
  sourceRef?: string;             // commit or tag, appended to each originNote
  area?: string;                  // area id, default for every item without its own productArea
  hypotheses: (NewHypothesisBase & { key: string })[];
  stakeholder: (BaselineRequirement & { key: string; hypothesisKeys?: string[] })[];
  solution: (BaselineRequirement & { stakeholderKeys?: string[]; hypothesisKeys?: string[] })[];
}
// NewHypothesisBase = Omit<NewHypothesis, "status" | "origin">; BaselineRequirement = Omit<DirectRequirement, "status" | "origin" | "kind" | "product">
export function recordBaseline(state: Collections, catalogue: Catalogue, input: BaselineInput, c: Ctx):
  { state: Collections; product: Product; created: { hypotheses: Record<string, string>; stakeholder: Record<string, string>; solution: string[] }; warnings: string[] }
```
- Rules:
  - Hypotheses get `status: "validated"` and `origin: "inferred"`. Requirements get `origin: "existing-product"`, and `kind` and `product` (the product id) set from the list they're in.
  - `originNote` defaults to `"Reverse-engineered from the existing product"` plus `` ` @ ${sourceRef}` `` when given; an item's own `originNote` wins.
  - Requirements get `status: "approved"`, `approvedBy`, `approvedAt: c.now` and `approvalNote: note`. `recordedBy: c.actor` is set when it differs from `approvedBy`. Solution requirements also get `plannedFor: version`.
  - Keys resolve to the new ids: `stakeholderKeys` go into `stakeholderIds` (added to any given ids), and `hypothesisKeys` go into `hypothesisIds`. An unknown key throws `ReleaseError("Unknown key …")`.
  - Version: if it's missing from `product.versions`, insert `{ version, status: "planned" }` at the **front** (it's the oldest). If it's planned, refuse when `pendingRelease(...).planned` has a requirement that isn't one of the new ones (`ReleaseError` naming the ids), then `releaseVersion(..., shipped: new solution ids)`. If it's released, refuse when it already introduced a requirement whose origin isn't `existing-product`, then `releaseRequirements(...)`.
  - `warnings`: one per new requirement whose title equals (ignoring case) the title of an existing requirement with the same `productArea` and product. Text: `` `"${title}" matches ${id} already in the baseline area` ``.

- [ ] **Step 1: Write failing tests** in `test/baseline.test.ts`:
  - `"records linked hypotheses and requirements, approved and released"`: 1 hypothesis (h1), 1 stakeholder (s1, `hypothesisKeys: ["h1"]`) and 2 solution requirements (`stakeholderKeys: ["s1"]`), into a new version "legacy" of a product with versions `["1.0"]`. Expect: the hypothesis is `validated`/`inferred`. All requirements are `approved` and `existing-product`, with `approvedBy: "maria"`, `recordedBy: "sam"` and `approvedAt: NOW`. Solution requirements have `releasedIn: "legacy"` and `stakeholderIds` = [s1's id]. s1 has `hypothesisIds` = [h1's id]. `product.versions[0]` is `{ version: "legacy", status: "released" }` and `versions[1].version === "1.0"`.
  - `"adds a second area to the released baseline"`: a second call on the returned state and product, with `stakeholderIds` pointing at the first call's stakeholder. The new solution requirement gets `releasedIn: "legacy"`, and the version stays released.
  - `"refuses a version with other work planned"`: the existing requirement `req("X", { plannedFor: "1.0" })` with origin unset, and version "1.0" named as the baseline. It throws `/X/`.
  - `"refuses a released version with non-baseline requirements"`.
  - `"refuses an unknown key"`.
  - `"a replacement shipping later makes the baseline requirement obsolete"`: after the baseline, add `req("N", { plannedFor: "1.0", replaces: [baselineId] })` and set the baseline's `obsoletedBy: ["N"]` and `obsoletePlannedFor: "1.0"`. Call `releaseVersion` for "1.0" shipping N. The baseline requirement ends up `obsolete` with `obsoletedIn: "1.0"`.
- [ ] **Step 2: Run** `npx vitest run test/baseline.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `recordBaseline`** with the rules above. Thread state through the ops with the same `apply` pattern the MCP layer uses: merge `change.next` into the collections.
- [ ] **Step 4: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** with the message `Add recordBaseline: approved, released as-is baseline in one change`.

### Task 4: `record_baseline` MCP tool

**Files:**
- Modify: `src/mcp/server.ts` (register after `correct_release`; mention it in `INSTRUCTIONS`)
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `recordBaseline` and `BaselineInput` (Task 3); Session helpers `requireReleaser`, `targetProduct`, `area`, `check`, `checkStakeholders`, `checkReplaces`; `layerProblem`, `wordingWarnings`; the `writeProducts`/`write` paths that `release_version` uses to return `products: [product]`.
- Input schema:
  - `product`: `productArg`
  - `version`: `versionArg`
  - `approvedBy`: `z.string().max(40)`
  - `note`: optional, `z.string().trim().max(300)`
  - `sourceRef`: optional, `z.string().trim().max(100)`
  - `area`: the `area` helper
  - `hypotheses`: `z.array(hypothesisInput.extend({ key: z.string().max(20) })).max(30).default([])`
  - `stakeholder`: `requirementInput.omit({ kind: true, product: true, stakeholderIds: true }).extend({ key, hypothesisKeys: z.array(z.string().max(20)).max(30).optional() })`, max 30, default `[]`
  - `solution`: `requirementInput.omit({ kind: true, product: true }).extend({ stakeholderKeys: z.array(z.string().max(20)).max(30).optional(), hypothesisKeys: z.array(z.string().max(20)).max(30).optional() })`, min 1, max 60
- Result: `{ version, created: { hypotheses, stakeholder, solution }, warnings?, report }`, with the final file ids after renaming (verify that `created` carries renamed ids, as `add_requirements` results do).
- Description (copy): "Record what an existing product already does as its as-is baseline: inferred hypotheses (validated), stakeholder and solution requirements (approved by approvedBy, origin existing-product), with the solution requirements released in `version`. One product area per call. Use only to document existing behaviour, after the user agreed to the list and named the approver. Link new items with keys (stakeholderKeys, hypothesisKeys) or existing ids."

- [ ] **Step 1: Write failing tests:**
  - `"records a baseline area and its release report"`: products in files with no versions; `record_baseline` with h1, s1 and one solution requirement for version "4.x", `approvedBy: "alex"`. Expect no error, `created.solution.length === 1`, and `report.introduced[0].id` matching `REQ-\d{4}`. `validate(load(root), readConfig(root), { root })` has no errors.
  - `"refuses an approver who isn't in people"`, with `approvedBy: "nobody"`: an error that mentions `config.yml people`, and no files are written.
  - `"refuses a legacy catalogue"`: the default `beforeEach` config (products in `config.yml`) gives an error matching `/groundwork migrate/`.
  - `"refuses a solution requirement that fulfils nothing"`: no `stakeholderKeys` or `stakeholderIds`, so an error from `layerProblem`.
  - `"warns on a title already in the baseline area"`: the same call twice, so the second result has `warnings` with `/matches REQ-/`.
- [ ] **Step 2: Run** `npx vitest run test/mcp.test.ts -t "baseline"`. Expected: FAIL.
- [ ] **Step 3: Implement the handler:**
  1. `requireReleaser()`.
  2. Refuse a legacy catalogue with the `add_product_versions` message.
  3. Resolve the product and `area`.
  4. Check that `approvedBy` is in `s.config.people` (the `approve_requirement` message).
  5. Run `s.check` on `hypothesisIds`, `findingIds`, `insightIds`, `checkStakeholders` on explicit `stakeholderIds`, and `checkReplaces`.
  6. Run `layerProblem` on each requirement with `kind` filled in and keys counted as stakeholder links, and collect `wordingWarnings`.
  7. Call `recordBaseline`, mapping `ReleaseError` to `UserError`.
  8. Return the state, `products: [product]` and the result with `releaseReport`.

  Add one line to `INSTRUCTIONS`: "Documenting an existing product: record_baseline, one area per call (see the skill)."
- [ ] **Step 4: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** with the message `Add record_baseline MCP tool`.

### Task 5: Baseline release report

**Files:**
- Modify: `src/store/release.ts` (`ReleaseReport`, `releaseReport`, `renderReleaseReport`)
- Test: `test/release.test.ts`

**Interfaces:**
- Produces: `ReleaseReport.baseline?: { areas: { area: string; stakeholder: number; solution: number }[] }`. It's set only when `introduced` is non-empty and every introduced requirement has `origin === "existing-product"`. Areas are sorted by id; requirements without an area count under `"(no area)"`. Stakeholder counts are the distinct stakeholder requirements met by that area's introduced solution requirements.
- Render: the heading `# ${title} ${version}: baseline report`, then a `## Areas` section after the "Released …" line, one line per area: `- **${area}**: ${stakeholder} stakeholder, ${solution} solution requirements`.

- [ ] **Step 1: Write failing tests:**
  - `"labels an all-baseline version and counts per area"`: two `existing-product` requirements in area "billing" and one in "auth". `renderReleaseReport` contains `: baseline report`, `- **auth**: 1 stakeholder, 1 solution requirements` and `- **billing**: 1 stakeholder, 2 solution requirements`.
  - `"keeps the normal report when any requirement isn't baseline"`: `baseline` is undefined and the heading says `release report`.
- [ ] **Step 2: Run** `npx vitest run test/release.test.ts -t "baseline"`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `npx vitest run`. Expected: all PASS (the README example report for acme is unchanged).
- [ ] **Step 5: Commit** with the message `Release report: label baseline versions and count per area`.

### Task 6: Skill, docs and release

**Files:**
- Modify: `skills/groundwork/SKILL.md`, `README.md`, `SPEC.md`, `CHANGELOG.md`, `package.json`

- [ ] **Step 1: SKILL.md.** Add the "When to reach for it" row: *"Asking to document, reverse-engineer or baseline what an existing product does"* → *"See 'Reverse-engineering an existing product'"*. Add that section with the five steps from the spec's Skill subsection (survey → areas → per-area drafts with `codeRefs` and one inferred hypothesis per major feature → show the list and flag suspected bugs, dead code and feature flags as questions, and ask who approves → `record_baseline` per area → report ids and `groundwork report release <version>`). In "When you plan work", add: in a modernization, new or changed behaviour gets new solution requirements with `replaces: [baseline id]`; never edit baseline items.
- [ ] **Step 2: README.md.** After "Releasing", add a "Starting from an existing product" section: 3–5 sentences, the example prompt *"Reverse-engineer the requirements of this codebase into a Legacy 4.x baseline"*, and how `replaces:` retires baseline items. Add `record_baseline` to the "Tools" list.
- [ ] **Step 3: SPEC.md.** Under "Fields by kind": `codeRefs` (requirements, hypotheses), hypothesis `origin`/`originNote`, and the `existing-product` origin. Under "Rules the tools apply": the `record_baseline` rules from Task 3 and the `codeRefs` validate warning.
- [ ] **Step 4: Release.** Bump `package.json` (and `package-lock.json` root entries) to `0.8.0`. Add a CHANGELOG `0.8.0` entry in the 0.7.0 style.
- [ ] **Step 5: Verify:**
  - `npm test && npm run build`. Expected: all pass, and the build succeeds.
  - Copy `examples/acme` to the scratchpad and run `node dist/cli.js validate` there. Expected: exit 0.
- [ ] **Step 6: Commit** with the message `Document reverse-engineering a baseline; 0.8.0`.
