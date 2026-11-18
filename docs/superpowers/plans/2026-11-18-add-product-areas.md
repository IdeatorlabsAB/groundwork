# Add product areas and products over MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two add-only MCP tools, `add_product_areas` and `add_products`, so an agent can configure areas and products in `groundwork/config.yml` itself.

**Architecture:** The merge rules (slugging, duplicate detection, collisions) are pure functions in a new `src/core/workspace.ts`, following CONTRIBUTING's "keep rules in core". The tools in `src/mcp/server.ts` go through a new config-only write wrapper that reuses the existing `migrated` and viewer guards and saves with `writeConfig`.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, zod 4, vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-add-product-areas-design.md`

## Global Constraints

- Add-only: never remove, rename or reorder an existing area or product. Never touch item files or `people`.
- Area ids must match the existing `slugId` regex in `src/store/config.ts`: `/^[a-z0-9][a-z0-9-]{0,39}$/`.
- Inputs: 1–20 entries per call.
- Refused when `config.yml` has `migrated:`, using the same message as other writes. Refused for viewers, using the same message.
- Duplicate checks are case-insensitive and ignore surrounding whitespace.
- Work on a branch `add-product-areas`, not `main`.

## Review Focus

1. A label that slugs to nothing (e.g. `"!!!"` or `"日本"`): give a clear error asking for an explicit `id`, not an invalid id written to config. → Task 1 test `rejects a label with no usable slug`.
2. The same new label twice in one call (`["Billing", "billing"]`): add it once and report the second as already there. → Task 1 test `dedupes within one call`.
3. No `config.yml` yet (a new project): the tool creates it from the default config with the new areas, and later item writes see them. → Task 2 test `creates config.yml when missing`.
4. An explicit `id` that is invalid (`"On Boarding"`): give a user-facing error naming the rule, not a crash. → Task 1 test `rejects an invalid explicit id`.
5. Existing hand-written `config.yml` fields (`name`, `people`, `schemaVersion`) survive the write unchanged. → Task 2 test `keeps other config fields`.

---

### Task 1: Merge rules in `src/core/workspace.ts`

**Files:**
- Create: `src/core/workspace.ts`
- Test: `test/workspace.test.ts`

**Interfaces:**
- Produces:
  - `export interface AreaEntry { id: string; label: string }`
  - `export class WorkspaceError extends Error {}`
  - `export function slugify(label: string): string`: lowercase; runs of anything other than `a-z0-9` become `-`; leading and trailing `-` trimmed; cut to 40 chars, then trailing `-` trimmed again. Returns `""` when nothing is left.
  - `export function mergeAreas(existing: AreaEntry[], input: { label: string; id?: string }[]): { list: AreaEntry[]; added: AreaEntry[]; alreadyThere: AreaEntry[] }`
  - `export function mergeProducts(existing: string[], input: string[]): { list: string[]; added: string[]; alreadyThere: string[] }`
- Rules for `mergeAreas`, in order, for each input:
  1. Trim the label. `id = input.id?.trim() ?? slugify(label)`.
  2. Empty slug: throw `WorkspaceError` `"<label>" has no letters or digits to make an id from. Give an id (lowercase letters, digits and dashes).`
  3. Explicit id fails the slug regex: throw `WorkspaceError` naming the id and the rule.
  4. If an area in the list so far (existing plus already added) has the same label (case-insensitive), it goes to `alreadyThere` as that existing entry. Labels are what agents match on, so any id given is ignored.
  5. Otherwise, if the id matches an area in the list so far: throw `WorkspaceError` `"<label>" would get the id "<id>", which "<other label>" already uses. Give a different id.` This settles the spec's two overlapping lines: an id match with a different label is the collision error.
  6. Otherwise append to `list` and `added`.
- `mergeProducts`: trim; an empty string throws `WorkspaceError`; case-insensitive match against the list so far goes to `alreadyThere` (the existing spelling); otherwise append.
- `existing` arrays are never mutated.

- [ ] **Step 1: Write the failing tests** in `test/workspace.test.ts`:
  - `slugify`: `slugify("Onboarding & Setup") === "onboarding-setup"`; `slugify("  Billing  ") === "billing"`; `slugify("!!!") === ""`; `slugify("a".repeat(50)).length === 40`.
  - `adds new areas with generated ids`: `mergeAreas([], [{ label: "Onboarding" }, { label: "Monthly reports" }])` gives `added` = `[{id:"onboarding",label:"Onboarding"},{id:"monthly-reports",label:"Monthly reports"}]`, and `list` equals `added`.
  - `skips an existing area by label`: existing `[{id:"onboarding",label:"Onboarding"}]` with input `[{label:"onboarding"}]` gives `added: []`, `alreadyThere: [{id:"onboarding",label:"Onboarding"}]`, `list` unchanged.
  - `dedupes within one call`: `mergeAreas([], [{label:"Billing"},{label:"billing"}])` gives `added.length === 1` and `alreadyThere.length === 1`.
  - `uses an explicit id`: `[{label:"Sign-up", id:"signup"}]` gives an id of `"signup"`.
  - `rejects a slug collision`: existing `[{id:"on-boarding",label:"On boarding"}]` with input `[{label:"On-boarding"}]` throws `WorkspaceError` matching `/already uses/`.
  - `rejects a label with no usable slug`: `[{label:"!!!"}]` throws matching `/Give an id/`.
  - `rejects an invalid explicit id`: `[{label:"Onboarding", id:"On Boarding"}]` throws `WorkspaceError`.
  - `does not mutate existing`: the existing array still has its original length after a merge that adds.
  - `mergeProducts`: `mergeProducts(["Acme app"], ["acme app", "Acme API", "Acme API"])` gives `added: ["Acme API"]`, `alreadyThere: ["Acme app", "Acme API"]`, `list: ["Acme app", "Acme API"]`; `mergeProducts([], ["  "])` throws `WorkspaceError`.

- [ ] **Step 2: Run them and check they fail**
  Run: `npx vitest run test/workspace.test.ts`
  Expected: FAIL, because `../src/core/workspace` can't be resolved.

- [ ] **Step 3: Implement `src/core/workspace.ts`** following the interfaces and rules above. Define the slug regex locally, with the same pattern as `config.ts` (core must not import from store).

- [ ] **Step 4: Run them and check they pass**
  Run: `npx vitest run test/workspace.test.ts && npm run typecheck`
  Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**
  ```bash
  git add src/core/workspace.ts test/workspace.test.ts
  git commit -m "Merge rules for adding product areas and products"
  ```

### Task 2: The `add_product_areas` and `add_products` tools

**Files:**
- Modify: `src/mcp/server.ts` (a new `writeConfigOnly` wrapper next to `write` around line 200; two tools registered after `add_requirements`; the unknown-area message at line ~127; the unknown-product message at line ~414; `INSTRUCTIONS` step 1 at line ~29)
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `mergeAreas`, `mergeProducts`, `WorkspaceError` from Task 1. Also `readConfig`, `writeConfig`, `isInitialized` from `src/store/config.ts`.
- Produces:
  - Tool `add_product_areas`: input `{ areas: { label: string (1–100 chars), id?: string }[] }` (1–20). Result `{ added: AreaEntry[], alreadyThere: AreaEntry[], productAreas: AreaEntry[], file: "groundwork/config.yml" }`.
  - Tool `add_products`: input `{ products: string[] (each 1–100 chars) }` (1–20). Result `{ added: string[], alreadyThere: string[], products: string[], file: "groundwork/config.yml" }`.
  - `writeConfigOnly = <A>(fn: (s: Session, args: A) => { config: Config; result: unknown }) => (args: A) => Promise<Result>`. It runs the same `migrated` and `canEdit()` checks as `write`, with the same messages (extract both into a shared helper rather than copying them), calls `writeConfig(root, config)`, and maps `WorkspaceError` and `UserError` to `fail(message)`.

- [ ] **Step 1: Write the failing tests** in a new `describe("product areas and products")` in `test/mcp.test.ts` (the `beforeEach` config already has the `Onboarding` area and the `Acme app` product):
  - `adds areas and an item can use them`: `add_product_areas` `{areas:[{label:"Billing"}]}` → `data.added` = `[{id:"billing",label:"Billing"}]`, `data.productAreas.length === 2`. Then `add_insights` with `productArea: "Billing"` has no error, and `readConfig(root).productAreas` includes `billing`.
  - `skips areas already there`: `{areas:[{label:"onboarding"}]}` → `data.added` is `[]` and `data.alreadyThere[0].id === "onboarding"`.
  - `reports a slug collision as an error`: first add `{label:"On boarding", id:"on-boarding"}`, then `{label:"On-boarding"}` gives `error` matching `/already uses/`.
  - `adds products`: `add_products` `{products:["Acme API","acme app"]}` → `data.added` = `["Acme API"]`, `data.alreadyThere` = `["Acme app"]`. Then `add_requirements` with `product: "Acme API"` (with an `origin`) has no error.
  - `keeps other config fields`: after both tools, `readConfig(root).name === "Acme"`, `people` has length 2, and `schemaVersion === 1`.
  - `creates config.yml when missing`: delete `groundwork/config.yml`, call `add_product_areas` `{areas:[{label:"Billing"}]}`, then `readConfig(root).productAreas` equals `[{id:"billing",label:"Billing"}]`.
  - `refused when migrated`: `writeConfig(root, { ...readConfig(root), migrated: "https://groundwork.example/app" })`, then both tools return `error` matching `/imported into the Groundwork web app/` and `readConfig(root).productAreas.length === 1`.
  - `refused for a viewer`: `writeConfig` with a person `{id:"vic",name:"Vic",role:"viewer"}`, set `process.env.GROUNDWORK_USER = "vic"`; `add_products` returns `error` matching `/viewer/`.
  - `unknown area points at the tool`: `add_insights` with `productArea: "Nope"` gives `error` matching `/add_product_areas/`. Same for an unknown product in `add_requirements`, which matches `/add_products/`.
  - `no item files written`: after `add_product_areas`, `load(root)` has the same item count as before.

- [ ] **Step 2: Run them and check they fail**
  Run: `npx vitest run test/mcp.test.ts -t "product areas and products"`
  Expected: FAIL with tool-not-found errors, and the message tests fail on the old wording.

- [ ] **Step 3: Implement it in `src/mcp/server.ts`**
  - Add `writeConfigOnly`, sharing the guards with `write`.
  - Register `add_product_areas` with description: `Add product areas to groundwork/config.yml so items can be tagged with them. Give labels; ids are made from them unless you pass one. Areas already there are skipped. Check get_workspace first and reuse an existing area rather than adding a near-duplicate. Can't rename or remove areas: those are edits to config.yml.`
  - Register `add_products` with description: `Add products to groundwork/config.yml so requirements can name them. Products already there are skipped. Check get_workspace first and reuse an existing name rather than adding a near-duplicate.`
  - Unknown-area message becomes: `Unknown product area "<value>". Areas in groundwork/config.yml: <known>. Add it with add_product_areas, or leave it out.`
  - Unknown-product message becomes: `Unknown product "<value>". Products in groundwork/config.yml: <known>. Add it with add_products, or leave it out.`
  - `INSTRUCTIONS` step 1 gets an extra sentence: `If an area or product you need is missing, add it with add_product_areas or add_products, after checking for an existing match.`

- [ ] **Step 4: Run everything and check it passes**
  Run: `npm test && npm run typecheck`
  Expected: all tests PASS, including the existing suites. No type errors.

- [ ] **Step 5: Commit**
  ```bash
  git add src/mcp/server.ts test/mcp.test.ts
  git commit -m "add_product_areas and add_products MCP tools"
  ```

### Task 3: Docs and release notes

**Files:**
- Modify: `README.md` (tools table near line 100: add `add_product_areas` and `add_products` to the Write column; the Setup section, adding one sentence that agents can add areas and products themselves)
- Modify: `SPEC.md` (the `config.yml` section near line 85: one line saying `add_product_areas` / `add_products` append to these lists and never remove)
- Modify: `skills/groundwork/SKILL.md` (the `get_workspace` bullet near line 27: if an area or product is missing, check for a close match, then add it with the tools)
- Modify: `CHANGELOG.md` (a new `## Unreleased` section at the top: `- add_product_areas and add_products: agents can add product areas and products to config.yml. Add-only; existing ones are skipped.`)

- [ ] **Step 1: Make the edits above**

- [ ] **Step 2: Check the build and the example**
  Run: `npm run build && node dist/cli.js validate` from `examples/acme` (i.e. `cd examples/acme && node ../../dist/cli.js validate`)
  Expected: the build succeeds and validate reports no errors.

- [ ] **Step 3: Commit**
  ```bash
  git add README.md SPEC.md skills/groundwork/SKILL.md CHANGELOG.md
  git commit -m "Document add_product_areas and add_products"
  ```
