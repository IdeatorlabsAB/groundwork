# Part 4: Versions on requirements, and obsolete at release. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Approving a solution requirement plans it for a planned product version.
- A requirement that is replaced stays valid until the version that ships its replacement. It doesn't become
  obsolete the moment the replacement is approved.

Releasing (setting `releasedIn` / `obsoletedIn`) is part 5.

**Architecture:**
- New optional requirement fields go in `src/core/types.ts` (shared with the web app, additive only).
- Planning lives in new core ops, `planRequirements` and `planObsolescence` in `src/core/ops.ts`.
- The MCP tools in `src/mcp/server.ts` decide what to plan, using the catalogue from part 3. A helper,
  `productOf(catalogue, requirement)`, finds which product's versions apply.
- `validate` checks every version reference against the product file.

**Tech Stack:** TypeScript, zod 4, @modelcontextprotocol/sdk, vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-product-catalogue-releases-design.md`. The parts that apply:
- "Requirement fields (solution requirements only)";
- the "Approval plans it" and "Obsolete waits for the release" rules;
- under "Settled after the builder check": "Obsolescence follows its replacement", "`replaces` field", "`in-delivery` stays", and the "can't be changed with update_item" part of "Who and when";
- the "Anti-goals" section.

## Global Constraints

- New `Requirement` fields, all optional:
  - `plannedFor` (version string);
  - `obsoletePlannedFor` (version string);
  - `replaces` (REQ ids);
  - `releasedIn`, `obsoletedIn`, `releasedAt`, `releasedBy`: declared now, set only by part 5.

  A version reference means a version of the requirement's product (see `productOf`).
- **Only solution requirements carry `plannedFor`, `releasedIn` and `obsoletedIn`.** Stakeholder requirements
  can still be replaced and made obsolete, but never through versions.
- `update_item` can't change `plannedFor`, `obsoletePlannedFor`, `releasedIn`, `obsoletedIn`, `releasedAt` or
  `releasedBy`. They aren't in `requirementInput` or `PATCHES`, so the existing strict patch parse rejects them.
  `replaces` is in `requirementInput`, so it can be set on drafts.
- `in-delivery` counts as approved for planning, replacing and planned obsolescence.
- **A project or product with no versions works exactly as today:**
  - approval needs no `plannedFor`;
  - replacing makes the old requirement obsolete straight away.
- `applyRequirementChanges` (the web app's derive-from-findings path; the local server doesn't call it) is
  unchanged. Switching it to planned obsolescence is web-app work.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A product with no versions, or a legacy project: approval without `plannedFor` succeeds, and a replacement
   makes the old requirement obsolete on approval, as today.
2. `plannedFor` naming a released version, a version of another product, or a version that doesn't exist: refused,
   and the message lists the planned versions.
3. The replacement is re-planned to a later version with `plan_requirements`: the old requirement's
   `obsoletePlannedFor` follows it.
4. `update_item` patching `plannedFor` or `releasedIn`: refused by the strict patch.
5. `replaces` naming a draft, or a requirement that's already obsolete: refused, and the message says to update
   the draft instead, or that it's already obsolete.

---

### Task 1: Fields, product lookup and validation

**Files:**
- Modify: `src/core/types.ts`: the new `Requirement` fields, each with a doc comment.
- Modify: `src/core/schemas.ts`: `replaces: ids("approved requirements this one replaces").optional()` in
  `requirementInput`.
- Modify: `src/store/files.ts`: add `"replaces"` to `LINK_FIELDS`.
- Modify: `src/mcp/server.ts`: `outgoing()` includes `r.replaces`.
- Modify: `src/store/catalogue.ts`: `productOf`, `plannedVersions`.
- Modify: `src/store/validate.ts`
- Test: `test/versions.test.ts` (new)

**Interfaces:**
- Produces, in `src/store/catalogue.ts`:
  - `productOf(c: Catalogue, r: Pick<Requirement, "product">): Product | undefined`: the requirement's product
    (by id or title), or the only product when there is exactly one.
  - `plannedVersions(p: Product): string[]`
  - `isVersioned(c: Catalogue, r: Pick<Requirement, "product">): boolean`: `productOf` returns a product with at
    least one version.
- `validate` rules, for active solution requirements unless noted:
  - **error** `plannedFor "<v>" isn't a version of <title>` (also for `obsoletePlannedFor`, `releasedIn`,
    `obsoletedIn`, each with its own field name);
  - **error** `releasedIn "<v>" isn't released yet`, when that version's status isn't `released`;
  - **error** `approved but not planned for a version of <title>: approve_requirement takes plannedFor`, when the
    status is approved or in-delivery, the product has at least one planned version, and both `plannedFor` and
    `releasedIn` are unset;
  - **error** `only solution requirements are planned for versions`, on a stakeholder requirement with any of
    `plannedFor`, `releasedIn` or `obsoletedIn`;
  - **warning** `planned for <v>, which is released, but not released in it`, when `plannedFor` is a released
    version and `releasedIn` is unset;
  - the `replaces` link check: it must point to existing requirements. Reuse the `link()` helper.

- [ ] **Step 1: Write the failing tests** in `test/versions.test.ts`. Set up a temp project (as in
  `test/catalogue.test.ts`) with product `PRD-0001` "Clinicare Web Application", with versions `1.0` (released)
  and `1.1` (planned), one stakeholder requirement `REQ-0001`, and a helper `solution(extra)` that writes
  `REQ-0002` linked to it with `product: PRD-0001`. Then one test per rule above, plus:
  - `productOf` falls back to the only product;
  - a requirement with no product and two products returns `undefined`;
  - a project with no versions has no version errors for an approved requirement.

```ts
it("errors on an approved solution requirement with no planned version", () => {
  solution({ status: "approved", approvedBy: "sam", approver: "sam" });
  expect(messages()).toContain("error: approved but not planned for a version of Clinicare Web Application: approve_requirement takes plannedFor");
});
it("errors on releasedIn pointing at a planned version", () => {
  solution({ status: "approved", plannedFor: "1.1", releasedIn: "1.1" });
  expect(messages()).toContain('error: releasedIn "1.1" isn\'t released yet');
});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/versions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the fields, the helpers and the rules.**
- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass. The acme example still validates: it has no versions yet.

- [ ] **Step 5: Commit** with the message `Requirement version fields and their validation`.

### Task 2: Planning on approval, and `plan_requirements`

**Files:**
- Modify: `src/core/ops.ts`: `planRequirements`
- Modify: `src/mcp/server.ts`: `approve_requirement` gets `plannedFor`; a new `plan_requirements` tool.
- Test: `test/ops.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Consumes: `productOf`, `plannedVersions` and `isVersioned` from Task 1.
- Produces:
  - `planRequirements(s: Collections, c: Ctx, ids: string[], version: string): Change<boolean>`. It sets
    `plannedFor` on each id. Any requirement whose `obsoletePlannedFor` came from one of these (it's in their
    `replaces`) moves to the same version. It logs `planned "<title>" for <version>`.
  - Session helper `checkPlanned(r: Requirement, version: string): string`. It returns the version, or throws a
    `UserError`:
    - `<v> isn't a planned version of <title>. Planned: <list>. Add one with add_product_versions.`;
    - `"<title>" has no product, and there's more than one: set its product first.`;
    - for a stakeholder requirement: `only solution requirements are planned for versions`.
- **`approve_requirement`** adds `plannedFor: z.string().max(40).optional()`, both with and without `approvedBy`:
  - for a solution requirement when `isVersioned` and the product has at least one planned version, it's required.
    The error is `Which version is "<title>" planned for? Pass plannedFor: one of <list>.`;
  - when given, it's checked with `checkPlanned`, and the requirement is approved and planned in the same write;
  - for a stakeholder requirement, `plannedFor` is refused with the stakeholder message.
- **`plan_requirements({ ids: REQ[], version })`:** re-plan approved or in-delivery solution requirements that
  aren't released yet to another planned version. Refuse a draft (`approve it first`), a released one
  (`"<title>" shipped in <v>`) and a stakeholder requirement.

- [ ] **Step 1: Write the failing tests:**
  - **ops:** `planRequirements` sets `plannedFor`, and moves `obsoletePlannedFor` on a replaced requirement.
  - **MCP**, with the product from Task 1's setup written into the MCP test root (versions `1.0` released, `1.1`
    and `1.2` planned):
    - approving a solution requirement without `plannedFor` → error listing `1.1, 1.2`;
    - with `plannedFor: "1.1"` → approved, and `plannedFor: "1.1"` stored;
    - `plannedFor: "1.0"` → refused (released);
    - `plannedFor: "9.9"` → refused;
    - a stakeholder requirement with `plannedFor` → refused; without it → approved;
    - verbal approval with `approvedBy` and `plannedFor` → both stored;
    - `plan_requirements` moves it to `1.2`, and refuses a draft;
    - in the legacy `beforeEach` setup (no product files), the existing approval tests pass unchanged.
- [ ] **Step 2: Run them and check they fail**
- [ ] **Step 3: Implement it.** Approve and plan in one `write()`: apply `approveRequirement`, then
  `planRequirements` on the result.
- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `Approving a solution requirement plans it for a version; plan_requirements`.

### Task 3: Replacements and planned obsolescence

**Files:**
- Modify: `src/core/ops.ts`: `planObsolescence`
- Modify: `src/mcp/server.ts`: check `replaces` in `add_requirements` and `update_item`; act on it on approval;
  `obsolete_requirement` gets `inVersion`.
- Modify: `src/core/requirements.ts`: `canBeReplaced`
- Test: `test/ops.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Produces:
  - `canBeReplaced(r: Pick<Requirement, "status">): boolean`: true for approved and in-delivery.
  - `planObsolescence(s: Collections, c: Ctx, ids: string[], version: string, by?: string[]): Change<boolean>`.
    It sets `obsoletePlannedFor: version` and, when given, `obsoletedBy: by`. Status is unchanged. It logs
    `"<title>" will be obsolete in <version>`.
- **`replaces` on `add_requirements` / `update_item`:** each id must be a requirement that `canBeReplaced`.
  Otherwise:
  - for a draft: `"<title>" is a draft: update it instead of replacing it.`;
  - for an obsolete one: `"<title>" is already obsolete.`;
  - for anything else: `"<title>" is <status>; only approved requirements can be replaced.`
- **When a requirement with `replaces` is approved:**
  - if it's a solution requirement and `plannedFor` is set (versioned): call `planObsolescence(replaces, plannedFor, [newId])`;
  - otherwise (no versions, or a stakeholder requirement): call `obsoleteRequirement(old, [newId])` for each
    replaced requirement, exactly as today.
- **`obsolete_requirement`** adds `inVersion: z.string().max(40).optional()`:
  - with it: check it with `checkPlanned` against the old requirement's product, then `planObsolescence`;
  - without it, and the requirement has `releasedIn`: refuse with `"<title>" shipped in <v>: pass inVersion, the
    version that removes it.`;
  - without it otherwise: as today;
  - it still accepts only approved requirements, plus in-delivery now.
- `INSTRUCTIONS` step 4 ("Change") and the skill's "When you plan work" Change bullet change to: for an approved
  requirement, add a new one with `replaces: [old id]`. The old one becomes obsolete when the new one ships, or
  straight away when the product has no versions. That replaces the current "make the old one obsolete with
  obsolete_requirement and replacedBy" wording.

- [ ] **Step 1: Write the failing tests:**
  - **ops:** `planObsolescence` keeps the status and sets the fields.
  - **MCP, versioned product:**
    - approve `REQ-A` for `1.1`;
    - add `REQ-B` with `replaces: [REQ-A]`, then approve it for `1.2`;
    - `REQ-A` is still approved, with `obsoletePlannedFor: "1.2"` and `obsoletedBy: [REQ-B]`;
    - `plan_requirements([REQ-B], "1.1")` moves `REQ-A` to `obsoletePlannedFor: "1.1"`.
  - **MCP, no versions (legacy setup):** the same flow leaves `REQ-A` `obsolete` straight away.
  - `replaces` naming a draft, and naming an obsolete requirement → each refused with its message.
  - `obsolete_requirement` with `inVersion: "1.2"` → still approved, with `obsoletePlannedFor: "1.2"`.
  - The instruction text contains `replaces`, and no longer contains `obsolete_requirement and replacedBy`.
    Update the existing guidance test if it asserts the old wording.
- [ ] **Step 2: Run them and check they fail**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `Replacements wait for the release that ships them; obsolete_requirement inVersion`.

### Task 4: Example and docs

**Files:**
- `examples/acme/groundwork/`:
  - give `PRD-0001` versions `1.0` (planned) and `1.1` (planned);
  - REQ-0002 (approved) gets `plannedFor: "1.0"`, written with a small script or by hand;
  - REQ-0003 stays a draft.
- `SPEC.md`: the requirement fields, links table (`replaces`) and the rules list.
- `skills/groundwork/SKILL.md`:
  - when approving, ask which planned version, unless there's only one;
  - replacing works through `replaces`.
- `README.md`: a short paragraph in "Products, areas and versions" on planning requirements for a version, and
  replacements waiting for the release.
- `CHANGELOG.md`: under Unreleased.

- [ ] **Step 1: Make the example and doc changes.**
- [ ] **Step 2: Check**

Run: `npm test && npm run build && (cd examples/acme && node ../../dist/cli.js validate && node ../../dist/cli.js trace REQ-0002)`
Expected: green, and `All items and links are valid.`

- [ ] **Step 3: Commit** with the message `Document planning requirements for versions and replacements`.
