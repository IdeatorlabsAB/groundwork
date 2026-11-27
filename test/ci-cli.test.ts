import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { prInputFromGit, runCiPrCommand } from "../src/ci-cli";
import { load, renderItem, save } from "../src/store/files";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gw-ci-pr-"));
  cpSync(join(__dirname, "../examples/acme/groundwork"), join(root, "groundwork"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const json = (out: { code: number; lines: string[] }) => JSON.parse(out.lines.join("\n"));

describe("groundwork ci pr", () => {
  it("ci pr prints valid JSON with the markdown", () => {
    const out = runCiPrCommand(root, { input: { body: "Adds the wizard.\n\nGroundwork: REQ-0003", commits: [], changed: [] } });
    expect(out.code).toBe(0);
    const r = json(out);
    expect(r.named.map((x: { key: string }) => x.key)).toEqual(["REQ-0003"]);
    expect(r.markdown).toContain("<!-- groundwork -->");
    expect(r.gaps).toEqual([]);
  });

  it("ci pr reads the items as they are in the checkout", () => {
    // The PR adds the requirement it names.
    writeFileSync(
      join(root, "groundwork/requirements/REQ-0099-new.md"),
      renderItem({ id: "REQ-0099", title: "Brand new", kind: "solution", story: "The app shall be new.", status: "draft", stakeholderIds: ["REQ-0001"], acceptanceCriteria: ["New"], findingIds: [], createdAt: "x" }),
    );
    const r = json(runCiPrCommand(root, { input: { body: "", commits: ["Add it\n\nGroundwork: REQ-0099"], changed: [] } }));
    expect(r.named.map((x: { key: string }) => x.key)).toEqual(["REQ-0099"]);
    expect(r.gaps).toEqual([{ type: "untested-requirement", key: "REQ-0099", title: "Brand new" }]);
  });

  it("ci pr matches codeRefs when the project is in a subfolder", () => {
    const loaded = load(root);
    save(root, loaded, { ...loaded.items, requirements: loaded.items.requirements.map((r) => (r.id === "REQ-0003" ? { ...r, status: "approved" as const, codeRefs: ["src/import"] } : r)) });
    const r = json(runCiPrCommand(root, { input: { body: "", commits: [], changed: ["apps/web/src/import/csv.ts", "other/src/import/x.ts"] }, pathPrefix: "apps/web/", linkBase: "https://github.com/acme/app/blob/abc/" }));
    expect(r.gaps).toContainEqual({ type: "unnamed-approved-change", key: "REQ-0003", title: "Keep audit log of imports for 7 years", paths: ["apps/web/src/import/csv.ts"] });
    expect(r.touched[0].link).toBe("https://github.com/acme/app/blob/abc/apps/web/groundwork/requirements/REQ-0003-keep-audit-log-of-imports-for-7-years.md");
  });

  it("ci pr with junit reports failed linked tests", () => {
    const junit = join(root, "junit.xml");
    writeFileSync(junit, '<testsuites><testsuite name="a"><testcase classname="test/import-audit.test.ts" name="import audit &gt; REQ-0003 records who, when and which file"><failure/></testcase></testsuite></testsuites>');
    const r = json(runCiPrCommand(root, { input: { body: "Groundwork: REQ-0003", commits: [], changed: [] }, junit: [junit] }));
    expect(r.gaps.map((g: { type: string }) => g.type)).toEqual(["failed-code-test"]);
  });

  it("ci pr with a broken JUnit file still reports, without test results", () => {
    const junit = join(root, "junit.xml");
    writeFileSync(junit, "<testsuites><testsuite");
    const out = runCiPrCommand(root, { input: { body: "Groundwork: REQ-0003", commits: [], changed: [] }, junit: [junit] });
    expect(out.code).toBe(0);
    const r = json(out);
    expect(r.warnings[0]).toMatch(/junit\.xml: The JUnit report isn't valid XML/);
    expect(r.markdown).toContain("junit.xml");
  });

  it("ci pr fails without a groundwork/ folder", () => {
    const empty = mkdtempSync(join(tmpdir(), "gw-ci-empty-"));
    const out = runCiPrCommand(empty, { input: { body: "Groundwork: REQ-0003", commits: [], changed: [] } });
    expect(out.code).toBe(1);
    expect(out.lines[0]).toMatch(/^No groundwork\/config\.yml in /);
    rmSync(empty, { recursive: true, force: true });
  });

  it("ci pr says when files in groundwork/ can't be read", () => {
    writeFileSync(join(root, "groundwork/requirements/REQ-0003-keep-audit-log-of-imports-for-7-years.md"), "not frontmatter");
    const r = json(runCiPrCommand(root, { input: { body: "Groundwork: REQ-0003", commits: [], changed: [] } }));
    expect(r.markdown).toContain("couldn't be read");
    expect(r.markdown).toContain("REQ-0003-keep-audit-log-of-imports-for-7-years.md");
  });

  it("ci pr refuses input that isn't a PR description", () => {
    expect(runCiPrCommand(root, { input: { nope: true } as never }).code).toBe(1);
  });
});

/** Outside GitHub there's no API to ask: the merge request's commits and changed files come from git. */
describe("ci pr --against, for GitLab, Bitbucket and other CI", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  function repo(sub = "") {
    const top = mkdtempSync(join(tmpdir(), "gw-ci-git-"));
    git(top, "init", "-q", "-b", "main");
    git(top, "config", "user.name", "T");
    git(top, "config", "user.email", "t@example.com");
    const project = join(top, sub);
    mkdirSync(project, { recursive: true });
    cpSync(join(__dirname, "../examples/acme/groundwork"), join(project, "groundwork"), { recursive: true });
    const loaded = load(project);
    save(project, loaded, { ...loaded.items, requirements: loaded.items.requirements.map((r) => (r.id === "REQ-0003" ? { ...r, status: "approved" as const, codeRefs: ["src/import"] } : r)) });
    git(top, "add", "-A");
    git(top, "commit", "-q", "-m", "base");
    git(top, "checkout", "-q", "-b", "feature");
    mkdirSync(join(project, "src/import"), { recursive: true });
    writeFileSync(join(project, "src/import/csv.ts"), "export {};\n");
    writeFileSync(join(top, "elsewhere.txt"), "x\n");
    git(top, "add", "-A");
    git(top, "commit", "-q", "-m", "Faster CSV import\n\nGroundwork: RSK-0001");
    return { top, project };
  }

  it("reads the commits and the changed files since the target branch", () => {
    const { top, project } = repo();
    try {
      const { input, pathPrefix } = prInputFromGit(project, "main", "Speeds up imports.");
      expect(input).toEqual({ body: "Speeds up imports.", commits: ["Faster CSV import\n\nGroundwork: RSK-0001"], changed: ["elsewhere.txt", "src/import/csv.ts"] });
      expect(pathPrefix).toBe("");
      const r = json(runCiPrCommand(project, { input, pathPrefix }));
      expect(r.named.map((x: { key: string }) => x.key)).toEqual(["RSK-0001"]);
      expect(r.gaps).toContainEqual(expect.objectContaining({ type: "unnamed-approved-change", key: "REQ-0003", paths: ["src/import/csv.ts"] }));
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  it("works when groundwork/ is in a subfolder of the repository", () => {
    const { top, project } = repo("apps/web");
    try {
      const { input, pathPrefix } = prInputFromGit(project, "main", "");
      expect(pathPrefix).toBe("apps/web/");
      const r = json(runCiPrCommand(project, { input, pathPrefix }));
      expect(r.gaps).toContainEqual(expect.objectContaining({ type: "unnamed-approved-change", key: "REQ-0003", paths: ["apps/web/src/import/csv.ts"] }));
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  it("an unknown target branch is a clear error", () => {
    const { top, project } = repo();
    try {
      expect(() => prInputFromGit(project, "origin/nope", "")).toThrow(/origin\/nope.*fetch/);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  it("--markdown prints the comment, and --fail-on-gaps exits 1 when there are gaps", () => {
    const md = runCiPrCommand(root, { input: { body: "", commits: ["Groundwork: REQ-0099"], changed: [] }, format: "markdown" });
    expect(md.code).toBe(0);
    expect(md.lines.join("\n")).toMatch(/^<!-- groundwork -->/);
    expect(runCiPrCommand(root, { input: { body: "Groundwork: REQ-0003", commits: [], changed: [] }, failOnGaps: true }).code).toBe(0);
    const loaded = load(root);
    save(root, loaded, { ...loaded.items, requirements: loaded.items.requirements.map((r) => (r.id === "REQ-0003" ? { ...r, codeTests: undefined, testCases: undefined } : r)) });
    expect(runCiPrCommand(root, { input: { body: "Groundwork: REQ-0003", commits: [], changed: [] }, failOnGaps: true }).code).toBe(1);
  });
});

describe("ci pr output", () => {
  it("a report that fails on gaps is still the report, not an error", () => {
    const loaded = load(root);
    save(root, loaded, { ...loaded.items, requirements: loaded.items.requirements.map((r) => (r.id === "REQ-0003" ? { ...r, codeTests: undefined, testCases: undefined } : r)) });
    const out = runCiPrCommand(root, { input: { body: "Groundwork: REQ-0003", commits: [], changed: [] }, failOnGaps: true, format: "markdown" });
    expect(out).toMatchObject({ code: 1, report: true });
    expect(runCiPrCommand(mkdtempSync(join(tmpdir(), "gw-ci-none-")), { input: { body: "", commits: [], changed: [] } }).report).toBeUndefined();
  });
});
