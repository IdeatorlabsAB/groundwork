import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clashProblems, findClashes, renumber } from "../src/store/branches";
import { readConfig, writeConfig } from "../src/store/config";
import { load, parseItem, renderItem } from "../src/store/files";
import { validate } from "../src/store/validate";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(sub = "") {
  const top = mkdtempSync(join(tmpdir(), "gw-branches-"));
  dirs.push(top);
  const root = join(top, sub);
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: top }); // the repo starts at `top`; the project may be deeper
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeConfig(root, { schemaVersion: 1, name: "Clinicare", productAreas: [], products: [], people: [] });
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const commit = (msg: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
  };
  return { root, git, write, commit };
}

const req = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  renderItem({
    id,
    title,
    kind: "stakeholder",
    story: `As a nurse I want ${title.toLowerCase()} so that patients are safe.`,
    acceptanceCriteria: ["Works"],
    priority: "must",
    status: "draft",
    findingIds: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  });
const solution = (id: string, title: string, stakeholderIds: string[]) =>
  req(id, title, { kind: "solution", story: `The system shall support ${title.toLowerCase()}.`, stakeholderIds });

const R = "groundwork/requirements";

/**
 * main: REQ-0001 (stakeholder), then REQ-0002-from-main (solution for REQ-0001).
 * feature (branched before REQ-0002-from-main): REQ-0002-from-feature (stakeholder) and REQ-0003 (solution for it).
 * Ends checked out on feature.
 */
export function scenario(opts: { featureNotes?: string; featureComment?: string; sub?: string } = {}) {
  const r = repo(opts.sub);
  r.write(`${R}/REQ-0001-need.md`, req("REQ-0001", "Need"));
  r.commit("base");
  r.git("branch", "feature");
  r.write(`${R}/REQ-0002-from-main.md`, solution("REQ-0002", "From main", ["REQ-0001"]));
  r.commit("main adds REQ-0002");
  r.git("checkout", "-q", "feature");
  let text = req("REQ-0002", "From feature", opts.featureNotes ? { notes: opts.featureNotes } : {});
  if (opts.featureComment) text = text.replace("---\n", `---\n${opts.featureComment}\n`);
  r.write(`${R}/REQ-0002-from-feature.md`, text);
  r.write(`${R}/REQ-0003-feature-solution.md`, solution("REQ-0003", "Feature solution", ["REQ-0002"]));
  r.commit("feature adds REQ-0002 and REQ-0003");
  return r;
}

/** main and feature both add REQ-0002 and REQ-0003, all four different items. Ends on feature. */
export function scenarioWithTwoClashes() {
  const r = repo();
  r.write(`${R}/REQ-0001-need.md`, req("REQ-0001", "Need"));
  r.commit("base");
  r.git("branch", "feature");
  r.write(`${R}/REQ-0002-main-a.md`, req("REQ-0002", "Main a"));
  r.write(`${R}/REQ-0003-main-b.md`, req("REQ-0003", "Main b"));
  r.commit("main");
  r.git("checkout", "-q", "feature");
  r.write(`${R}/REQ-0002-feature-a.md`, req("REQ-0002", "Feature a"));
  r.write(`${R}/REQ-0003-feature-b.md`, req("REQ-0003", "Feature b"));
  r.commit("feature");
  return r;
}

describe("id clashes against a base branch", () => {
  it("finds an id the branch shares with a different item on the base", () => {
    const r = scenario();
    expect(findClashes(r.root, "main")).toEqual([
      { id: "REQ-0002", path: `${R}/REQ-0002-from-feature.md`, basePath: `${R}/REQ-0002-from-main.md` },
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
    dirs.push(dir);
    expect(() => findClashes(dir, "main")).toThrow(/Not a git repository/);
  });

  it("finds the clash after the base was merged into the branch", () => {
    const r = scenario();
    r.git("merge", "-q", "--no-edit", "main");
    expect(findClashes(r.root, "main").map((c) => c.path)).toEqual([`${R}/REQ-0002-from-feature.md`]);
  });

  it("validate --against reports the clash and points at renumber", () => {
    const r = scenario();
    expect(clashProblems(r.root, "main")[0]).toMatchObject({
      level: "error",
      file: `${R}/REQ-0002-from-feature.md`,
      message: expect.stringMatching(/groundwork renumber --against main/),
    });
  });
});

describe("renumber", () => {
  it("gives the branch's clashing item the next free id and fixes links to it", () => {
    const r = scenario();
    const out = renumber(r.root, "main");
    expect(out.renumbered).toEqual([
      { from: "REQ-0002", to: "REQ-0004", oldPath: `${R}/REQ-0002-from-feature.md`, newPath: `${R}/REQ-0004-from-feature.md` },
    ]);
    const sol = parseItem(readFileSync(join(r.root, `${R}/REQ-0003-feature-solution.md`), "utf8"));
    expect(sol.data.stakeholderIds).toEqual(["REQ-0004"]);
    expect(findClashes(r.root, "main")).toEqual([]);
  });

  it("after merging the base, keeps the base's item and its links untouched", () => {
    const r = scenario();
    r.git("merge", "-q", "--no-edit", "main");
    renumber(r.root, "main");
    const fromMain = readFileSync(join(r.root, `${R}/REQ-0002-from-main.md`), "utf8");
    expect(fromMain).toBe(r.git("show", `main:${R}/REQ-0002-from-main.md`));
    expect(validate(load(r.root), readConfig(r.root)).filter((p) => p.level === "error")).toEqual([]);
  });

  it("reports, but doesn't rewrite, the old id in notes", () => {
    const r = scenario({ featureNotes: "Split out of REQ-0002 after review." });
    const out = renumber(r.root, "main");
    expect(out.mentions).toEqual([{ file: `${R}/REQ-0004-from-feature.md`, id: "REQ-0002" }]);
    expect(readFileSync(join(r.root, out.renumbered[0].newPath), "utf8")).toContain("Split out of REQ-0002 after review.");
  });

  it("keeps hand formatting of the frontmatter", () => {
    const r = scenario({ featureComment: "# drafted with Maria" });
    renumber(r.root, "main");
    expect(readFileSync(join(r.root, `${R}/REQ-0004-from-feature.md`), "utf8")).toContain("# drafted with Maria");
  });

  it("does nothing the second time", () => {
    const r = scenario();
    renumber(r.root, "main");
    expect(renumber(r.root, "main")).toEqual({ renumbered: [], rewritten: [], mentions: [], tickets: [], tests: [] });
  });

  it("numbers several clashes of one kind without new clashes", () => {
    const r = scenarioWithTwoClashes();
    const out = renumber(r.root, "main");
    expect(out.renumbered.map((x) => x.to)).toEqual(["REQ-0004", "REQ-0005"]);
    expect(findClashes(r.root, "main")).toEqual([]);
  });
});

describe("renumber in real-world setups", () => {
  it("works when the project is in a subfolder of the repo", () => {
    const r = scenario({ sub: "apps/my app" });
    expect(findClashes(r.root, "main").map((c) => c.id)).toEqual(["REQ-0002"]);
    expect(renumber(r.root, "main").renumbered.map((x) => x.to)).toEqual(["REQ-0004"]);
  });

  it("never rewrites the base's items when git converts line endings", () => {
    const r = scenario();
    r.git("merge", "-q", "--no-edit", "main");
    r.git("config", "core.autocrlf", "true");
    r.git("rm", "-q", "-r", "--cached", ".");
    r.git("reset", "-q", "--hard");
    const before = readFileSync(join(r.root, `${R}/REQ-0002-from-main.md`), "utf8");
    expect(before).toContain("\r\n");
    const out = renumber(r.root, "main");
    expect(out.renumbered.map((x) => x.oldPath)).toEqual([`${R}/REQ-0002-from-feature.md`]);
    expect(readFileSync(join(r.root, `${R}/REQ-0002-from-main.md`), "utf8")).toBe(before);
    expect(out.rewritten).not.toContain(`${R}/REQ-0002-from-main.md`);
  });

  it("keeps a base item's links to the base's item when the branch edits it after merging", () => {
    const r = repo();
    r.write(`${R}/REQ-0001-need.md`, req("REQ-0001", "Need"));
    r.commit("base");
    r.git("branch", "feature");
    r.write(`${R}/REQ-0002-main-need.md`, req("REQ-0002", "Main need"));
    r.write(`${R}/REQ-0003-main-sol.md`, solution("REQ-0003", "Main sol", ["REQ-0002"]));
    r.commit("main");
    r.git("checkout", "-q", "feature");
    r.write(`${R}/REQ-0002-feat.md`, req("REQ-0002", "Feat"));
    r.commit("feature");
    r.git("merge", "-q", "--no-edit", "main");
    const file = join(r.root, `${R}/REQ-0003-main-sol.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace("title: Main sol", "title: Main solution"));
    expect(renumber(r.root, "main").renumbered.map((x) => x.to)).toEqual(["REQ-0004"]);
    expect(parseItem(readFileSync(file, "utf8")).data.stakeholderIds).toEqual(["REQ-0002"]);
  });

  it("never overwrites an existing file, even an unreadable one", () => {
    const r = scenario();
    writeFileSync(join(r.root, `${R}/REQ-0004-draft.md`), "half-written, no frontmatter");
    const out = renumber(r.root, "main");
    expect(out.renumbered.map((x) => x.to)).toEqual(["REQ-0005"]);
    expect(readFileSync(join(r.root, `${R}/REQ-0004-draft.md`), "utf8")).toBe("half-written, no frontmatter");
  });
});

describe("renumber and product files", () => {
  it("gives the branch's product the next free id and fixes requirements that name it", () => {
    const r = repo();
    r.write(`${R}/REQ-0001-need.md`, req("REQ-0001", "Need"));
    r.commit("base");
    r.git("branch", "feature");
    r.write("groundwork/products/PRD-0001-clinicare-web.md", renderItem({ id: "PRD-0001", title: "Clinicare Web", areas: [], versions: [] }));
    r.commit("main adds a product");
    r.git("checkout", "-q", "feature");
    r.write("groundwork/products/PRD-0001-clinicare-mobile.md", renderItem({ id: "PRD-0001", title: "Clinicare Mobile", areas: [], versions: [] }));
    r.write(`${R}/REQ-0002-mobile-sol.md`, req("REQ-0002", "Mobile sol", { kind: "solution", story: "The app shall work.", stakeholderIds: ["REQ-0001"], product: "PRD-0001" }));
    r.commit("feature adds a product");
    const out = renumber(r.root, "main");
    expect(out.renumbered).toEqual([
      { from: "PRD-0001", to: "PRD-0002", oldPath: "groundwork/products/PRD-0001-clinicare-mobile.md", newPath: "groundwork/products/PRD-0002-clinicare-mobile.md" },
    ]);
    expect(parseItem(readFileSync(join(r.root, `${R}/REQ-0002-mobile-sol.md`), "utf8")).data.product).toBe("PRD-0002");
  });
});

describe("renumber and tests", () => {
  it("says which linked tests still name the old id", () => {
    const r = repo();
    r.write(`${R}/REQ-0001-need.md`, req("REQ-0001", "Need"));
    r.commit("base");
    r.git("branch", "feature");
    r.write(`${R}/REQ-0002-main.md`, req("REQ-0002", "Main"));
    r.commit("main");
    r.git("checkout", "-q", "feature");
    r.write(
      `${R}/REQ-0002-feat.md`,
      req("REQ-0002", "Feat", {
        codeTests: [
          { path: "test/feat.test.ts", name: "feat > REQ-0002 works", linkedAt: "x", linkedBy: "sam" },
          { path: "test/feat.test.ts", name: "feat > other", linkedAt: "x", linkedBy: "sam" },
        ],
        testCases: [{ tool: "testrail", id: "C9", title: "REQ-0002 works", linkedAt: "x", linkedBy: "sam" }],
      }),
    );
    r.commit("feature");
    expect(renumber(r.root, "main").tests).toEqual([{ from: "REQ-0002", to: "REQ-0003", tests: ['test/feat.test.ts "feat > REQ-0002 works"', "testrail C9 REQ-0002 works"] }]);
  });
});

describe("renumber and tickets", () => {
  it("says which tickets in the tracker still name the old id", () => {
    const r = repo();
    r.write(`${R}/REQ-0001-need.md`, req("REQ-0001", "Need"));
    r.commit("base");
    r.git("branch", "feature");
    r.write(`${R}/REQ-0002-main.md`, req("REQ-0002", "Main"));
    r.commit("main");
    r.git("checkout", "-q", "feature");
    r.write(`${R}/REQ-0002-feat.md`, req("REQ-0002", "Feat", { tickets: [{ tracker: "linear", key: "CLN-142", linkedAt: "x", linkedBy: "sam" }] }));
    r.commit("feature");
    expect(renumber(r.root, "main").tickets).toEqual([{ from: "REQ-0002", to: "REQ-0003", tickets: ["linear CLN-142"] }]);
  });
});
