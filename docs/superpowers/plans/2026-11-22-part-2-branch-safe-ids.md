# Part 2: Branch-safe ids. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two people on separate clones or branches who both create `REQ-0012` find out before merging, and one
command gives the branch's items free ids and fixes the links to them.

**Architecture:**
- A new module, `src/store/branches.ts`, reads the base branch's item files with git (`git ls-tree` and
  `git cat-file`). It compares them with the working tree by **file path**. File names never change once an item
  is created (SPEC), so the same id at a different path means a different item.
- The CLI gets `validate --against <ref>` and `renumber --against <ref>`. `validate` without `--against` stays as
  it is and never needs git.
- Renumbering edits the YAML frontmatter in place with `YAML.parseDocument`, so formatting is kept, and it never
  touches Markdown bodies.

**Tech Stack:** TypeScript, the `yaml` package, git through `node:child_process` `execFileSync`, and vitest
(with real temporary git repos in the tests).

**Spec:** `docs/superpowers/specs/2026-11-22-product-catalogue-releases-design.md`, under "Added after the
developer review": "Everyone works from their own clone" and "Ids stay safe across branches".

## Global Constraints

- Readable ids stay as they are, e.g. `REQ-0012`. There are no new id formats.
- Ids that already exist on the base branch are never renumbered.
- References are rewritten only in files the branch added or changed, meaning files whose content differs from
  the base ref, including untracked ones.
- Markdown bodies are never rewritten (SPEC: the body is the user's). Mentions of a renumbered id in a body are
  reported, not changed.
- A renamed file keeps its slug: only the id at the start of the file name changes
  (`REQ-0012-guided-import.md` becomes `REQ-0014-guided-import.md`).
- `validate` without `--against` works without git, exactly as today.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Not a git repo, or `--against` names a ref that doesn't exist: a clear error, exit code 1, and no files
   changed.
2. The base branch was merged into the branch, so the working tree holds two files with the same id: the file
   that's on the base keeps its id, and the branch's file is renumbered.
3. A link to a renumbered item is rewritten in files the branch changed. The same id in a file that's unchanged
   from the base (the base's own item) is left alone.
4. A renumbered id mentioned in a Markdown body is reported in the output, not rewritten.
5. Running `renumber` a second time changes nothing and says so.

---

### Task 1: Detect id clashes against a base branch

**Files:**
- Create: `src/store/branches.ts`
- Modify: `src/store/files.ts` (export `LINK_FIELDS`, and add the renumber hint to the duplicate-id message)
- Modify: `src/cli.ts` (`--against` option, `validate --against`)
- Test: `test/branches.test.ts` (new)

**Interfaces:**
- Produces, all in `src/store/branches.ts`:
  - `class GitError extends Error`
  - `interface ItemFile { id: string; path: string; data: Record<string, unknown>; text: string }`: `path` is
    relative to the project root, e.g. `groundwork/requirements/REQ-0012-x.md`.
  - `itemsAt(root: string, ref: string): ItemFile[]`: item files under `groundwork/<collection>/` at `ref`. Throws
    `GitError` (`Not a git repository` / `Unknown branch or commit "<ref>"`).
  - `itemsInWorkingTree(root: string): ItemFile[]`: every parseable item file on disk. Unlike `load()`,
    duplicates are kept. Unparseable files are skipped, because `validate` reports them.
  - `interface Clash { id: string; path: string; basePath: string }`
  - `findClashes(root: string, ref: string): Clash[]`: working-tree items whose id exists at `ref` under a
    different path.
  - `clashProblems(root: string, ref: string): Problem[]`: one `error` per clash, with the message
    `` `${id} is also used by ${basePath} on ${ref}. Run: groundwork renumber --against ${ref}` ``.
- `LINK_FIELDS` is exported from `src/store/files.ts`.

Test helper: a `repo()` function in `test/branches.test.ts`.
- It makes a temporary dir, runs `git init -q -b main`, sets `user.name` and `user.email` locally, and writes
  `groundwork/config.yml` with `writeConfig`.
- It returns `{ root, git(...args), write(relPath, text), commit(msg) }`. Item text is built with `renderItem`
  from `src/store/files.ts`.

Scenario used by several tests:
- On `main`, commit `REQ-0001-need.md`: a stakeholder requirement.
- Create the branch `feature`.
- Back on `main`, commit `REQ-0002-from-main.md`: a solution requirement with `stakeholderIds: [REQ-0001]`.
- On `feature`, commit:
  - `REQ-0002-from-feature.md`, a stakeholder requirement;
  - `REQ-0003-feature-solution.md`, a solution requirement with `stakeholderIds: [REQ-0002]`, meaning the
    feature's REQ-0002.

- [ ] **Step 1: Write the failing tests**

```ts
it("finds an id the branch shares with a different item on the base", () => {
  const r = scenario();
  expect(findClashes(r.root, "main")).toEqual([
    { id: "REQ-0002", path: "groundwork/requirements/REQ-0002-from-feature.md", basePath: "groundwork/requirements/REQ-0002-from-main.md" },
  ]);
});
it("finds no clash for items the branch shares with the base", () => {
  const r = scenario();
  r.git("checkout", "-q", "main");
  expect(findClashes(r.root, "main")).toEqual([]);
});
it("refuses a ref that doesn't exist", () => {
  const r = scenario();
  expect(() => findClashes(r.root, "nope")).toThrow(/Unknown branch or commit "nope"/);
});
it("refuses a folder that isn't a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-nogit-"));
  expect(() => findClashes(dir, "main")).toThrow(/Not a git repository/);
});
it("finds the clash after the base was merged into the branch", () => {
  const r = scenario();
  r.git("merge", "-q", "--no-edit", "main");
  expect(findClashes(r.root, "main").map((c) => c.path)).toEqual(["groundwork/requirements/REQ-0002-from-feature.md"]);
});
it("validate --against reports the clash and points at renumber", () => {
  const r = scenario();
  expect(clashProblems(r.root, "main")[0]).toMatchObject({ level: "error", file: "groundwork/requirements/REQ-0002-from-feature.md", message: expect.stringMatching(/groundwork renumber --against main/) });
});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/branches.test.ts`
Expected: FAIL, because `../src/store/branches` doesn't exist.

- [ ] **Step 3: Implement `src/store/branches.ts`**
- Run git with `execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })`.
  - Check the repo with `git rev-parse --git-dir`.
  - Check the ref with `git rev-parse --verify --quiet <ref>^{commit}`.
- For `itemsAt`:
  - list files with `git ls-tree -r --name-only <ref> -- groundwork/`;
  - keep only `groundwork/<collection>/*.md` for the five collections in `COLLECTIONS`;
  - read them all in one `git cat-file --batch` call (input `<ref>:<path>` per line);
  - parse each with `parseItem`.
- Export `LINK_FIELDS` from `files.ts`.
- Change `load()`'s duplicate message to end with: ` If they come from different branches, run: groundwork
  renumber --against <base branch>`.

- [ ] **Step 4: Run them and check they pass**

Run: `npx vitest run test/branches.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire up the CLI.** In `src/cli.ts`:
  - add an `against: { type: "string" }` option;
  - `cmdValidate(json, against?)` appends `clashProblems(root, against)` when `against` is given;
  - a `GitError` prints in red and exits 1;
  - the HELP line becomes `groundwork validate [--json] [--against <base>]   Check every item and link; with
    --against, also ids that clash with <base>. Exits 1 on errors`.

- [ ] **Step 6: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/store/branches.ts src/store/files.ts src/cli.ts test/branches.test.ts
git commit -m "validate --against: find ids a branch shares with different items on its base"
```

### Task 2: Renumber a branch's clashing items

**Files:**
- Modify: `src/store/branches.ts`
- Modify: `src/cli.ts` (`renumber` command)
- Test: `test/branches.test.ts`

**Interfaces:**
- Consumes: `findClashes`, `itemsAt`, `itemsInWorkingTree`, `GitError` and `LINK_FIELDS` from Task 1.
- Produces:
  - `interface Renumbered { from: string; to: string; oldPath: string; newPath: string }`
  - `renumber(root: string, ref: string): { renumbered: Renumbered[]; rewritten: string[]; mentions: { file: string; id: string }[] }`

Algorithm, which the signature and tests don't fully pin down:
1. `clashes = findClashes(root, ref)`. If there are none, return empty lists.
2. Per kind prefix, `next` = 1 + the highest number used at `ref` or in the working tree. Give the clashes new
   ids in order of `path`, counting up from `next`.
3. `changed` = working-tree item files whose text differs from the same path at `ref`, or that don't exist at
   `ref`. Include the renumbered files themselves.
4. For each file in `changed`, parse it with `YAML.parseDocument` and rewrite the frontmatter:
   - the item's own `id`, if it's being renumbered;
   - `hypothesisId`;
   - each value in `LINK_FIELDS` that maps `from` to `to`.

   Write the frontmatter back as `doc.toString({ lineWidth: 0 })`, with the body kept byte-for-byte. Add the file
   to `rewritten` only if its text changed.
5. Rename each renumbered file by replacing the leading id in its basename (`git mv` isn't needed; a plain rename
   is fine).
6. `mentions`: any file in `changed` whose body contains a `from` id as a whole word.

- [ ] **Step 1: Write the failing tests**

```ts
it("gives the branch's clashing item the next free id and fixes links to it", () => {
  const r = scenario();
  const out = renumber(r.root, "main");
  expect(out.renumbered).toEqual([
    { from: "REQ-0002", to: "REQ-0004", oldPath: "groundwork/requirements/REQ-0002-from-feature.md", newPath: "groundwork/requirements/REQ-0004-from-feature.md" },
  ]);
  const sol = parseItem(readFileSync(join(r.root, "groundwork/requirements/REQ-0003-feature-solution.md"), "utf8"));
  expect(sol.data.stakeholderIds).toEqual(["REQ-0004"]);
  expect(findClashes(r.root, "main")).toEqual([]);
});
it("after merging the base, keeps the base's item and its links untouched", () => {
  const r = scenario();
  r.git("merge", "-q", "--no-edit", "main");
  renumber(r.root, "main");
  const fromMain = readFileSync(join(r.root, "groundwork/requirements/REQ-0002-from-main.md"), "utf8");
  expect(fromMain).toBe(r.git("show", "main:groundwork/requirements/REQ-0002-from-main.md"));
  expect(validate(load(r.root), readConfig(r.root)).filter((p) => p.level === "error")).toEqual([]);
});
it("reports, but doesn't rewrite, the old id in notes", () => {
  const r = scenario({ featureNotes: "Split out of REQ-0002 after review." });
  const out = renumber(r.root, "main");
  expect(out.mentions).toEqual([{ file: "groundwork/requirements/REQ-0004-from-feature.md", id: "REQ-0002" }]);
  expect(readFileSync(join(r.root, out.renumbered[0].newPath), "utf8")).toContain("Split out of REQ-0002 after review.");
});
it("keeps hand formatting of the frontmatter", () => {
  const r = scenario({ featureComment: "# drafted with Maria" });
  renumber(r.root, "main");
  expect(readFileSync(join(r.root, "groundwork/requirements/REQ-0004-from-feature.md"), "utf8")).toContain("# drafted with Maria");
});
it("does nothing the second time", () => {
  const r = scenario();
  renumber(r.root, "main");
  expect(renumber(r.root, "main")).toEqual({ renumbered: [], rewritten: [], mentions: [] });
});
it("numbers several clashes of one kind without new clashes", () => {
  const r = scenarioWithTwoClashes(); // main and feature both add REQ-0002 and REQ-0003, all different items
  const out = renumber(r.root, "main");
  expect(out.renumbered.map((x) => x.to)).toEqual(["REQ-0004", "REQ-0005"]);
  expect(findClashes(r.root, "main")).toEqual([]);
});
```

`scenario()` takes optional `featureNotes`, the body of the feature's REQ-0002, and `featureComment`, a YAML
comment line put just after the opening `---`.

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/branches.test.ts -t "renumber|clashing|notes|formatting|second time|several"`
Expected: FAIL, because `renumber` isn't exported.

- [ ] **Step 3: Implement `renumber`** in `src/store/branches.ts`, following the algorithm above.

- [ ] **Step 4: Run them and check they pass**

Run: `npx vitest run test/branches.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Add the CLI command** `renumber --against <base>` in `src/cli.ts`.
  - Without `--against`, print `Usage: groundwork renumber --against <base branch>` and exit 1.
  - Output, one line per item: `REQ-0002 → REQ-0004  groundwork/requirements/REQ-0004-from-feature.md`.
  - Then `Updated links in: <files>`.
  - Then, for each mention: `warning <file>: mentions REQ-0002 in its notes; update that by hand`.
  - When nothing clashes: `Nothing to renumber: no ids clash with <base>.`
  - Exit 0.
  - HELP gets `groundwork renumber --against <base>   Give this branch's items that clash with <base> new ids,
    and fix links`.

- [ ] **Step 6: Run the full suite, the typecheck and the build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/store/branches.ts src/cli.ts test/branches.test.ts
git commit -m "groundwork renumber --against: give a branch's clashing items free ids and fix links"
```

### Task 3: README, SPEC, skill and CHANGELOG

**Files:** `README.md`, `SPEC.md`, `skills/groundwork/SKILL.md`, `CHANGELOG.md`

- [ ] **Step 1: README**
- In "The CLI", add `validate --against origin/main` and `renumber --against origin/main`.
- Change the CI example:
  - `actions/checkout@v4` with `fetch-depth: 0`;
  - `npx -y -p groundwork-mcp groundwork validate --against origin/${{ github.base_ref }}`.
- Add a "Working on branches" section, after "Requirements in two layers". It covers:
  - everyone (developers and product managers) works on their own clone;
  - ids are numbered per clone, so two branches can both create `REQ-0012`;
  - CI catches it;
  - `groundwork renumber --against origin/main` fixes it on the branch before merging;
  - ids already on main never change.
- Bring the rest of the README up to date with 0.4: check the Tools table lists every tool the server registers,
  and that the Quickstart prompts include writing requirements before building. Fix anything that's stale.
- [ ] **Step 2: SPEC.** In the Ids paragraph, add that a clash between branches is fixed with `renumber`, which
  gives the branch's item the next free id, renames its file and rewrites links in the files the branch changed.
- [ ] **Step 3: Skill.** In Rules, add: if `groundwork validate` reports an id that clashes with the base branch,
  run `npx -p groundwork-mcp groundwork renumber --against <base>`, tell the user which ids changed, and mention
  any notes it flags.
- [ ] **Step 4: CHANGELOG.** Under a new `## Unreleased`, add `validate --against` and `renumber --against`.
- [ ] **Step 5: Check the build and the example**

Run: `npm test && npm run build && (cd examples/acme && node ../../dist/cli.js validate)`
Expected: green, and `All items and links are valid.`

- [ ] **Step 6: Commit**

```bash
git add README.md SPEC.md skills/groundwork/SKILL.md CHANGELOG.md
git commit -m "Document working on branches: validate --against and renumber"
```
