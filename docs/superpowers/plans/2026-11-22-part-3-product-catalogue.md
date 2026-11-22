# Part 3: Product catalogue and migration. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team keeps its product structure in the repo, as product files. Each file holds one product, with its
areas and its versions. `groundwork migrate` moves existing projects over. Versions on requirements and releasing
are parts 4 and 5.

**Architecture:**
- Products are files in `groundwork/products/PRD-0001-<slug>.md`, read by `load()` into a new `Loaded.products`.
  They are not part of `Collections` (`src/core/collections.ts`), which is shared with the hosted web app, so
  nothing on that side changes.
- A `Catalogue` (`src/store/catalogue.ts`) answers "which areas and products exist?". It's built from product
  files, or from the old flat `config.yml` lists for projects that haven't migrated. The server, `validate`,
  `get_workspace` and the import all ask the catalogue instead of reading `config.productAreas` and
  `config.products` directly.

**Tech Stack:** TypeScript, zod 4, the `yaml` package, @modelcontextprotocol/sdk, vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-product-catalogue-releases-design.md`. The parts that apply:
- "Product files";
- "Tools and validation", for product tools only;
- "Migration";
- "Migration is explicit" and "version's permanent key" under "Settled after the builder check";
- "One repo usually holds one product".

## Global Constraints

- **Product file location and prefix:** `groundwork/products/`, prefix `PRD`, file name `<id>-<slug>.md`. It
  follows the existing item-file rules: frontmatter, the id never changes, the slug is fixed at creation, and the
  body holds the user's notes and is never rewritten.
- **Product frontmatter:** `id`, `title`, `areas: [{ id, label }]`,
  `versions: [{ version, status: planned | released, plannedFor?, releasedAt?, releasedBy? }]`, `createdAt`.
  Unknown fields are kept.
- **Version order** is the order in the list. There's no semver parsing. A version string is unique within its
  product, and `(product id, version)` is its permanent key.
- **Area ids are unique across all products in the repo**, so an item's `productArea` points to exactly one
  product. Insights, hypotheses and findings get no product field.
- **Migration is explicit.**
  - A `config.yml` with non-empty flat `productAreas` or `products` lists, and no product files, is *legacy*.
    Legacy projects keep working exactly as today, and so does `add_products` / `add_product_areas` on them.
  - Version features (`add_product_versions`) refuse with: `Run "groundwork migrate" first: products and their
    versions now live in groundwork/products/.`
  - Nothing migrates as a side effect of another write.
- **`schemaVersion: 2`:**
  - `SCHEMA_VERSION` becomes 2, and `readConfig` accepts 1 and 2.
  - `migrate` sets 2. So does writing the first product file in a project that has no flat lists (nothing to
    migrate).
  - `init` writes 2.
- **The import bundle keeps its shape:** `config.productAreas` (flattened across products) and `config.products`
  (product titles). The CLI prints `Product versions aren't imported yet.` when any product has versions.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A legacy project, untouched by `migrate`, behaves exactly as before. All existing tests pass unchanged, apart
   from lines that pin `schemaVersion: 1` for new projects.
2. Running `migrate` twice: the second run says `Nothing to migrate.` and changes nothing.
3. A migrated project whose `config.yml` still has flat lists, e.g. added back by hand: `validate` warns that
   they're ignored, and the product files win.
4. Two products defining the same area id: `validate` errors, and `add_product_areas` refuses.
5. A requirement whose `product` names a product title instead of its id after migration: the tools resolve the
   title to the id on write, and `validate` errors on a value that matches neither.

---

### Task 1: Product files and the catalogue

**Files:**
- Create: `src/store/products.ts`, `src/store/catalogue.ts`
- Modify: `src/store/files.ts` (`Loaded.products`, loading `groundwork/products/`)
- Modify: `src/store/config.ts` (`SCHEMA_VERSION = 2`; accept 1 and 2)
- Test: `test/catalogue.test.ts` (new)

**Interfaces:**
- Produces, in `src/store/products.ts`:
  - `interface ProductVersion { version: string; status: "planned" | "released"; plannedFor?: string; releasedAt?: string; releasedBy?: string }`
  - `interface Product { id: string; title: string; areas: { id: string; label: string }[]; versions: ProductVersion[]; createdAt?: string; notes?: string }`
  - `productSchema` (zod, `.loose()`)
  - `PRODUCTS_DIR = "products"`, `PRODUCT_PREFIX = "PRD"`
  - `loadProducts(root: string): { products: Product[]; paths: Map<string, string>; problems: FileProblem[] }`
  - `writeProduct(root: string, product: Product, path?: string): string`: returns the relative path. An existing
    file is edited in place with `YAML.parseDocument`, so comments survive and the body is kept.
  - `nextProductId(products: Product[]): string`
- In `src/store/files.ts`, `Loaded` gains `products: Product[]`. Their paths go into `loaded.paths`, and their
  problems into `loaded.problems`.
- Produces, in `src/store/catalogue.ts`:
  - `interface CatalogueArea { id: string; label: string; productId?: string }`
  - `interface Catalogue { legacy: boolean; products: Product[]; areas: CatalogueArea[]; productNames: string[] }`
  - `catalogueOf(config: Config, products: Product[]): Catalogue`. With products, it's built from them (legacy
    false). Otherwise it's built from `config.productAreas` and `config.products`, with each name becoming a
    product with no id and no versions. Legacy is true when those lists aren't empty.
  - `findArea(c: Catalogue, value: string): CatalogueArea | undefined` matches by id, or by label ignoring case.
  - `findProduct(c: Catalogue, value: string): Product | undefined` matches by id, or by title ignoring case.

- [ ] **Step 1: Write the failing tests** in `test/catalogue.test.ts`. They use a temp project dir with
  `writeConfig`, and product files written with `writeProduct`.

```ts
it("loads product files into the catalogue", () => {
  writeProduct(root, { id: "PRD-0001", title: "Clinicare Web Application", areas: [{ id: "scheduling", label: "Scheduling" }], versions: [{ version: "1.0", status: "planned" }] });
  const c = catalogueOf(readConfig(root), load(root).products);
  expect(c.legacy).toBe(false);
  expect(c.areas).toEqual([{ id: "scheduling", label: "Scheduling", productId: "PRD-0001" }]);
  expect(findProduct(c, "clinicare web application")?.id).toBe("PRD-0001");
  expect(findArea(c, "SCHEDULING")?.productId).toBe("PRD-0001");
});
it("treats flat config lists without product files as a legacy catalogue", () => {
  writeConfig(root, { ...readConfig(root), productAreas: [{ id: "onboarding", label: "Onboarding" }], products: ["Acme app"] });
  const c = catalogueOf(readConfig(root), load(root).products);
  expect(c).toMatchObject({ legacy: true, productNames: ["Acme app"], areas: [{ id: "onboarding", label: "Onboarding" }] });
});
it("keeps notes and comments when a product file is rewritten", () => {
  const path = writeProduct(root, { id: "PRD-0001", title: "Clinicare", areas: [], versions: [] });
  writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replace("---\n", "---\n# ours\n") + "\nRoadmap notes.\n");
  writeProduct(root, { ...load(root).products[0], versions: [{ version: "1.0", status: "planned" }] }, path);
  const text = readFileSync(join(root, path), "utf8");
  expect(text).toContain("# ours");
  expect(text).toContain("Roadmap notes.");
  expect(load(root).products[0].versions).toEqual([{ version: "1.0", status: "planned" }]);
});
it("reads schemaVersion 1 and 2, and refuses 3", () => {
  writeConfig(root, { ...readConfig(root), schemaVersion: 2 });
  expect(readConfig(root).schemaVersion).toBe(2);
  writeConfig(root, { ...readConfig(root), schemaVersion: 3 });
  expect(() => readConfig(root)).toThrow(/understands up to 2/);
});
it("numbers new products after the highest", () => {
  expect(nextProductId([{ id: "PRD-0002", title: "x", areas: [], versions: [] }])).toBe("PRD-0003");
});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/catalogue.test.ts`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement `products.ts` and `catalogue.ts`, extend `load()`, and set `SCHEMA_VERSION = 2`.**
  - `writeConfig`'s default for new projects (`defaultConfig`) becomes `schemaVersion: 2`.
  - `test/mcp.test.ts:328` (`expect(config.schemaVersion).toBe(1)`) still holds: that test writes 1 itself in
    `beforeEach`, and `appendToConfig` doesn't change it.

- [ ] **Step 4: Run the tests and the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `Product files and the catalogue`.

### Task 2: Everything reads the catalogue

**Files:**
- Modify: `src/mcp/server.ts`: `Session` gets `readonly catalogue: Catalogue`. `areaLabel`, `area()`, the product
  lookup in `add_requirements` and `update_item`, and `get_workspace` all use it.
- Modify: `src/store/validate.ts`
- Modify: `src/store/import.ts`, `src/cli.ts` (the import notice)
- Test: `test/catalogue.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Consumes: `catalogueOf`, `findArea`, `findProduct` and `Loaded.products` from Task 1.
- Rules:
  - **`get_workspace`** returns `products: [{ id?, title, areas, versions }]`, `productAreas` (flattened
    `CatalogueArea[]`) and `catalogue: "files" | "legacy"`. For legacy it also returns
    `migrate: "Run groundwork migrate to move products into groundwork/products/ and add versions."`.
  - **The `product` field on requirements:**
    - on write with product files, a title or id resolves to the **id**;
    - legacy keeps today's behaviour (case-insensitive name, stored as the config spelling);
    - the unknown-product error lists the product titles and points at `add_products`.
  - **`validate`, with product files:**
    - error: `productArea "<x>" is defined by both PRD-0001 and PRD-0002` (an area id in two products);
    - error: `version "<v>" is listed twice`, on the product file;
    - error: a solution requirement's `product` that isn't a product id. If it matches a title, the message is
      `use the product id PRD-0001 instead of its title`.
    - warning: `config.yml productAreas/products are ignored: products live in groundwork/products/`, when flat
      lists remain alongside product files.
  - **`validate`, legacy:** messages unchanged.

- [ ] **Step 1: Write the failing tests:**
  - **MCP** (in a new `describe("product files")`, with a product file `PRD-0001` "Clinicare Web Application",
    area `scheduling`):
    - `add_requirements` with `product: "clinicare web application"` stores `product: "PRD-0001"`;
    - `add_insights` with `productArea: "Scheduling"` stores `scheduling`;
    - `get_workspace` returns `catalogue: "files"` and the product with its areas.
  - **Validate**, in `test/catalogue.test.ts`, one test per message above: duplicate area across products,
    duplicate version, product title used instead of id, flat lists ignored.
- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/catalogue.test.ts test/mcp.test.ts -t "product files|catalogue"`
Expected: FAIL.

- [ ] **Step 3: Implement the rules above.** `buildBundle` flattens the catalogue into the existing
  `productAreas` / `products` fields. `cmdImport` prints the versions notice.
- [ ] **Step 4: Run the full suite and check all existing legacy tests pass unchanged**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `Read areas and products from the catalogue`.

### Task 3: Product tools on product files

**Files:**
- Modify: `src/mcp/server.ts` (`add_products`, `add_product_areas`, new `add_product_versions`)
- Modify: `src/core/workspace.ts` (reuse `mergeAreas` and `mergeProducts`; add
  `mergeVersions(existing: ProductVersion[], input: { version: string; plannedFor?: string }[]): { list; added; alreadyThere }`)
- Test: `test/mcp.test.ts`, `test/workspace.test.ts`

**Interfaces:**
- **`add_products({ products: string[] })`:**
  - with product files, or with no flat lists at all (a new project), it creates a product file per new title and
    sets `schemaVersion: 2`. The result lists each product's `id` and `file`;
  - legacy: unchanged, appending to `config.yml`.
- **`add_product_areas({ areas, product? })`:**
  - with product files: `product` (id or title) is required when there's more than one product. It refuses when
    there are no products ("Add a product first with add_products."). It refuses an area id already used by
    another product. It writes the product file;
  - legacy: unchanged.
- **`add_product_versions({ product?, versions: [{ version, plannedFor? }] })`:**
  - product files only. It's add-only, and new versions are `planned`, appended in the order given. Versions
    already there are reported in `alreadyThere`;
  - legacy: refuses with the Global Constraints message;
  - `product` is required when there's more than one product.
- `INSTRUCTIONS` and `get_workspace`'s description mention products, areas and versions. The tool list test
  (`lists the same tools as the hosted server`) gains `add_product_versions` (local only, like the other two).

- [ ] **Step 1: Write the failing tests:**
  - `mergeVersions`: adds new versions, skips existing ones, and dedupes within a call.
  - MCP tools on a new project (no flat lists):
    - `add_products(["Clinicare Web Application"])` creates `groundwork/products/PRD-0001-clinicare-web-application.md`
      and sets `schemaVersion: 2`;
    - `add_product_areas` with five areas (Settings and configuration, Scheduling, Prescriptions, Medical
      Records, Patient Data Protection) writes them to that file;
    - `add_product_versions` with `["1.0", "1.1"]` adds them as planned;
    - with a second product, `add_product_areas` without `product` refuses, and a duplicate area id refuses;
    - legacy: `add_product_versions` refuses with `groundwork migrate`, and the existing legacy tests for
      `add_products` / `add_product_areas` pass unchanged.
- [ ] **Step 2: Run them and check they fail**
- [ ] **Step 3: Implement the tools.** Use `writeProduct`, and edit `config.yml` in place (as `appendToConfig`
  does) to set `schemaVersion: 2`.
- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit** with the message `Product tools write product files; add_product_versions`.

### Task 4: `groundwork migrate`

**Files:**
- Create: `src/store/migrate.ts`
- Modify: `src/cli.ts` (`migrate [--dry-run]`)
- Modify: `src/store/branches.ts` (include `products/` in `FOLDERS`, and `product` as a scalar link field in
  `rewriteFrontmatter`)
- Modify: `examples/acme/groundwork/`: migrated, with `migrate` itself
- Test: `test/migrate.test.ts` (new), `test/branches.test.ts`, `test/import.test.ts`

**Interfaces:**
- Produces:
  - `interface MigrationPlan { products: Product[]; requirementProducts: { file: string; from: string; to: string }[]; unknownProducts: { file: string; value: string }[]; notes: string[] }`
  - `planMigration(root: string): MigrationPlan | undefined`: `undefined` when there's nothing to migrate.
  - `migrate(root: string): MigrationPlan | undefined`: applies the plan.

Algorithm:
1. Not legacy (product files exist, or there are no flat lists): return `undefined`.
2. Products come from `config.products`, or, if that's empty, a single product titled `config.name`. Ids go from
   `PRD-0001` in list order.
3. All `config.productAreas` go to the **first** product. With more than one product, add the note
   `All areas went to <first title>. Move any that belong to another product by editing the product files.`
4. A requirement with a `product` matching a title (ignoring case) gets the product id. This is written through
   `save()`, so only those files change. An unmatched value is left as it is and listed in `unknownProducts`.
5. `config.yml` is edited in place: remove `productAreas` and `products`, set `schemaVersion: 2`. Comments and
   other keys are kept.

CLI output:
- `--dry-run` prints the plan and writes nothing.
- A normal run prints the plan, then `Migrated. Older groundwork-mcp versions won't read this folder: update them
  with npx -y groundwork-mcp@latest.`
- With nothing to do: `Nothing to migrate.` Exit 0 in every case.

- [ ] **Step 1: Write the failing tests** in `test/migrate.test.ts`. Start from a copy of `examples/acme` (one
  product "Acme app", one area):
  - a dry run returns the plan and changes no file (compare a hash of every file before and after);
  - a real run writes `groundwork/products/PRD-0001-acme-app.md` with area `onboarding`, sets the acme
    requirements' `product` to `PRD-0001`, and leaves `config.yml` with `schemaVersion: 2` and no flat lists.
    Other keys and the header comment are kept;
  - `validate` reports no errors afterwards;
  - a second run returns `undefined`;
  - two products: both are created, and the areas-went-to-first note is present;
  - an unknown requirement product is listed in `unknownProducts`, and its file is left unchanged.

  Add to `test/branches.test.ts`: two branches both create `PRD-0001`. `renumber` gives the branch's one
  `PRD-0002`, and rewrites `product: PRD-0001` on the branch's new requirements.
- [ ] **Step 2: Run them and check they fail**
- [ ] **Step 3: Implement `migrate.ts`, the CLI command and the `branches.ts` changes.** Then run
  `node dist/cli.js migrate` inside `examples/acme` after `npm run build`.
- [ ] **Step 4: Update `test/import.test.ts` for the migrated acme.** The bundle still has
  `config.products: ["Acme app"]` and the same item counts, because the bundle shape is unchanged.
- [ ] **Step 5: Run the full suite, the build and the example**

Run: `npm test && npm run typecheck && npm run build && (cd examples/acme && node ../../dist/cli.js validate)`
Expected: green, and `All items and links are valid.`

- [ ] **Step 6: Commit** with the message `groundwork migrate: move products and areas into product files`.

### Task 5: Docs

**Files:** `README.md` (Setup section, CLI list, a short "Products and versions" section), `SPEC.md` (product
files, config v2, migration), `skills/groundwork/SKILL.md` (get_workspace now shows products and versions;
`add_product_versions`; suggest `groundwork migrate` when `get_workspace` says legacy), `CHANGELOG.md` (Unreleased,
including **Breaking** for the folder and older versions after migrating).

- [ ] **Step 1: Write the docs.** Use the user's example everywhere a product appears: product *Clinicare Web
  Application*, areas *Settings and configuration, Scheduling, Prescriptions, Medical Records, Patient Data
  Protection*.
- [ ] **Step 2: Check**

Run: `npm test && npm run build && (cd examples/acme && node ../../dist/cli.js validate)`
Expected: green.

- [ ] **Step 3: Commit** with the message `Document the product catalogue and groundwork migrate`.
