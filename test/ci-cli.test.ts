import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCiPrCommand } from "../src/ci-cli";
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
