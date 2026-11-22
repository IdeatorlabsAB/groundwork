import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clashProblems, findClashes } from "../src/store/branches";
import { writeConfig } from "../src/store/config";
import { renderItem } from "../src/store/files";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo() {
  const root = mkdtempSync(join(tmpdir(), "gw-branches-"));
  dirs.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
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
export function scenario(opts: { featureNotes?: string; featureComment?: string } = {}) {
  const r = repo();
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
