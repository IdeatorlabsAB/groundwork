# Reverse-engineer a baseline from an existing product

## Context

Groundwork assumes requirements are written *before* code. Teams that modernize a legacy product with agents have the opposite problem: the product exists, the spec doesn't. They want their agent to read the legacy codebase and produce a trusted **as-is baseline** of requirements and the original product bets. The modernized product's requirements then `replace:` those, with full traceability.

Decisions from the conversation:
- Reverse-engineered requirements are a **shipped baseline**: approved, and released in a baseline version of the product (e.g. "Legacy 4.x").
- Hypotheses capture the **inferred original bets** behind major features, recorded as `validated` because the feature shipped.
- Approach **B**: skill workflow, schema fields, a `record_baseline` batch tool, and `validate` checks on code references. No code scanner: the agent reads the code.

Size: a project. Step 1 of implementation is writing this up as `docs/superpowers/specs/2026-11-25-reverse-engineer-baseline-design.md`, then a plan in `docs/superpowers/plans/` (the repo's existing pattern).

## Approaches considered

- A. Skill guidance plus `origin`/`codeRefs` fields, using the existing add → approve → release tools. Cheap, but hundreds of calls for a real product.
- **B. A plus the `record_baseline` batch tool and `codeRefs` validation (chosen).** One review step and one call per product area.
- C. B plus a language-aware scanner for coverage. Rejected: language-specific and heavy, and the agent reads code better than a parser.

## Design

### Schema (`src/core/schemas.ts`, `src/core/types.ts`)
- `REQUIREMENT_ORIGIN` gets `"existing-product"`. `originNote` says where it came from, e.g. "Reverse-engineered from billing-service @ 3f2a1c9".
- New optional `codeRefs: string[]` (max 50, each ≤ 300 chars) on requirements and hypotheses. Each entry is a repo-relative path, optionally with `#symbol` or `:line` (e.g. `src/billing/invoice.ts#applyDiscount`). It's added to `requirementInput`, `hypothesisInput` and their `PATCHES`.
- Hypotheses get an optional `origin: "inferred"` plus `originNote`. That marks a bet read from shipped code, not one tested by an experiment.

### Core op: `recordBaseline` (`src/core/ops.ts`, release logic in `src/store/release.ts`)
Input, per call (one product area at a time):
```
{ product, version, area?, approvedBy, note?, sourceRef?,      // sourceRef = commit/tag, put in originNote
  hypotheses:  [{ key, ...hypothesisInput, codeRefs }],
  stakeholder: [{ key, ...requirementInput(kind stakeholder), hypothesisKeys?, codeRefs }],
  solution:    [{ ...requirementInput(kind solution), stakeholderKeys?/stakeholderIds?, hypothesisKeys?, codeRefs }] }
```
- `key`s are local labels ("s1", "h2") so one call can link new items. Solution requirements may also point at existing stakeholder REQ ids from earlier areas.
- It creates the hypotheses (status `validated`, origin `inferred`) and the requirements (origin `existing-product`), all approved by `approvedBy` with `recordedBy` = the actor and the note. Solution requirements are released into `version`.
- Version handling: if `version` doesn't exist, it's created on the product. While it's planned, the first call releases it through the existing `releaseVersion` path, and later calls (more areas) go through `releaseRequirements` into the now-released version. It reuses the existing ReleaseError checks. It refuses when the version already holds non-baseline work planned for it, so that work isn't swept into the release.
- Validation as in `add_requirements`: every solution requirement fulfils at least one stakeholder requirement, and the same wording warnings apply. It also warns when a title matches an existing requirement's title in the same product area (re-runs).
- Atomic: all or nothing. It returns the created ids grouped per key.

### MCP tool (`src/mcp/server.ts`)
- `record_baseline`, wrapping `recordBaseline` through the same load → op → save path as `add_requirements` and `release_version`. The description says to use it only for documenting behaviour that already exists, and only after the user has agreed to the area's list and named the approver.
- `add_requirements`, `add_hypotheses` and `update_item` accept `codeRefs` through the schema changes.

### Validate (`src/store/validate.ts`)
- Warns when a `codeRefs` path (the part before `#`/`:`) doesn't exist relative to the repo root (the folder holding `groundwork/`). Code moves, so this is a warning, not an error.
- Doesn't warn "no insights linked" on hypotheses with `origin: inferred`, or "no evidence linked" on requirements with origin `existing-product` (it should already skip origin'd requirements; confirm).

### Report (`src/store/release.ts` `releaseReport`/`renderReleaseReport`)
- For a version whose requirements are all `existing-product`, the heading reads "baseline" and the report adds a per-area count of stakeholder and solution requirements, so the team can see coverage at a glance. No new CLI command: `groundwork report release <version>` covers it.

### Skill (`skills/groundwork/SKILL.md`) and server `INSTRUCTIONS`
- New "When to reach for it" row: *"Asking to document, reverse-engineer or baseline what an existing product does"* → see the new section.
- New section **"Reverse-engineering an existing product"**:
  1. `get_workspace`. Make sure the product exists, then agree the baseline version name with the user (default: the product's current version number, else "legacy").
  2. Survey the code: entry points, routes and screens, background jobs, integrations, data model, permissions and roles. Propose product areas and add them (`add_product_areas`).
  3. Per area, read the code and tests. Draft stakeholder needs (roles from permissions and UI copy), "shall" statements of observed behaviour, acceptance criteria from validation rules and tests, `codeRefs`, and one inferred hypothesis per major feature.
  4. Show the area's list to the user. Point out suspected bugs, dead code and feature-flagged paths as questions rather than baking them in. Ask who approves the baseline.
  5. `record_baseline` for the area. Repeat for each area. At the end, report the ids and the release report command.
- In "When you plan work": in a modernization, a behaviour-preserving rewrite or a change adds new solution requirements (in the new product, or the next version) with `replaces: [baseline id]`. Baseline items are never edited in place.

### Docs
- README: a short "Starting from an existing product" section with an example prompt ("Reverse-engineer the requirements of this codebase into a Legacy 4.x baseline").
- SPEC.md: the `existing-product` origin, hypothesis `origin`, `codeRefs`, the `record_baseline` rules and the validate warning.
- CHANGELOG entry, plus a version bump in `package.json` (0.8.0), matching the 0.7.0 release pattern.
- Hosted web app import (`src/store/import.ts`): check that the extra fields pass through or are dropped cleanly. Supporting them in the web app is out of scope.

## Files
- `src/core/schemas.ts`, `src/core/types.ts`: fields and enum value
- `src/core/ops.ts`: `recordBaseline`
- `src/store/release.ts`: version creation and release reuse, baseline report
- `src/mcp/server.ts`: `record_baseline` tool and INSTRUCTIONS
- `src/store/validate.ts`: `codeRefs` existence warning, origin exemptions
- `skills/groundwork/SKILL.md`, `README.md`, `SPEC.md`, `CHANGELOG.md`, `package.json`
- Tests: new `test/baseline.test.ts`, plus additions to `test/mcp.test.ts` and the validate tests, reusing `test/fixtures.ts`

## Verification
- `npm test` (vitest). New tests cover: one call creates linked hypotheses, stakeholder and solution items, approved and released; a second call for another area adds to the released version; a solution requirement without a stakeholder is refused; it refuses a version with planned non-baseline work; a missing `codeRefs` path warns in validate; a later requirement with `replaces:` a baseline id makes it obsolete on release.
- `npm run build`, then run the CLI against a temp copy of `examples/acme`: `groundwork validate` and `groundwork report release legacy`.
- Manual end-to-end check: with the MCP server connected, ask Claude Code to baseline a small sample folder (e.g. `src/store` of this repo treated as a product) and review the files it writes.
