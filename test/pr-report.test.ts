import { describe, expect, it } from "vitest";
import { emptyCollections, type Collections } from "../src/core/collections";
import type { CodeTestResult } from "../src/core/junit";
import { groundworkKeys, prReport } from "../src/core/pr-report";
import { defaultMatrix } from "../src/core/risk";
import type { Requirement } from "../src/core/types";

// Ported from centropic-prototype test/ci-pr-report.test.ts, with local ids for keys and files for links.
const base = { acceptanceCriteria: ["Works"], findingIds: [], priority: "must" as const, createdAt: "x" };
function items(): Collections {
  return {
    ...emptyCollections(),
    insights: [{ id: "INS-0001", title: "I", quote: "q", source: "interview", persona: "P", tags: [], sentiment: "neutral", createdAt: "x", createdBy: "sam" }],
    requirements: [
      { ...base, id: "REQ-0001", title: "Set up without help", kind: "stakeholder", story: "As an admin I want to import alone so that I start fast.", status: "approved" },
      { ...base, id: "REQ-0002", title: "Guided CSV import", kind: "solution", story: "The system shall guide the import.", status: "draft", stakeholderIds: ["REQ-0001"] },
      { ...base, id: "REQ-0003", title: "Import templates", kind: "solution", story: "The system shall offer templates.", status: "approved", stakeholderIds: ["REQ-0001"], codeRefs: ["src/import"] },
    ] as Requirement[],
    risks: [{ id: "RSK-0001", title: "Import maps columns to the wrong fields", hazard: "h", harm: "x", probability: 5, severity: 5, mitigationIds: [], versions: [], codeRefs: ["src/import/map.ts#guess"], createdAt: "x" }],
  };
}
const files = new Map([
  ["REQ-0002", "groundwork/requirements/REQ-0002-guided-csv-import.md"],
  ["REQ-0003", "groundwork/requirements/REQ-0003-import-templates.md"],
  ["RSK-0001", "groundwork/risks/RSK-0001-import-maps-columns.md"],
]);
const LINK = "https://github.com/acme/app/blob/abc123/";
const report = (keys: string[], changedPaths: string[], c = items(), linkBase: string | undefined = LINK) => prReport({ keys, changedPaths, items: c, matrix: defaultMatrix(), files, linkBase });

describe("groundworkKeys", () => {
  it("reads every Groundwork: line, in order, without duplicates", () => {
    expect(groundworkKeys("Fix it\n\nGroundwork: req-0042, RSK-0007\n", "Groundwork: REQ-0042 INS-0001")).toEqual(["REQ-0042", "RSK-0007", "INS-0001"]);
  });

  it("returns nothing without a trailer", () => {
    expect(groundworkKeys("Mentions REQ-0042 in passing", "")).toEqual([]);
  });
});

describe("prReport", () => {
  it("unknown and non-requirement keys are listed as not found", () => {
    const r = report(["REQ-9999", "INS-0001", "REQ-0002"], []);
    expect(r.unknownKeys).toEqual(["REQ-9999", "INS-0001"]);
    expect(r.named.map((x) => x.key)).toEqual(["REQ-0002"]);
  });

  it("links point at files under the link base", () => {
    expect(report(["REQ-0002"], []).named[0]).toMatchObject({ file: "groundwork/requirements/REQ-0002-guided-csv-import.md", link: `${LINK}groundwork/requirements/REQ-0002-guided-csv-import.md` });
    expect(report(["REQ-0002"], []).markdown).toContain(`[Guided CSV import](${LINK}groundwork/requirements/REQ-0002-guided-csv-import.md)`);
  });

  it("without a link base, the comment shows file paths", () => {
    const r = prReport({ keys: ["REQ-0002"], changedPaths: [], items: items(), matrix: defaultMatrix(), files });
    expect(r.named[0].link).toBeUndefined();
    expect(r.markdown).toContain("| REQ-0002 | Guided CSV import (`groundwork/requirements/REQ-0002-guided-csv-import.md`) | named |");
  });

  it("finds a named solution requirement without tests", () => {
    expect(report(["REQ-0002"], []).gaps).toContainEqual({ type: "untested-requirement", key: "REQ-0002", title: "Guided CSV import" });
  });

  it("doesn't count a requirement with a linked code test as untested", () => {
    const c = items();
    c.requirements = c.requirements.map((r) => (r.id === "REQ-0002" ? { ...r, codeTests: [{ path: "test/a.test.ts", name: "imports", linkedAt: "", linkedBy: "" }] } : r));
    expect(report(["REQ-0002"], [], c).gaps).toEqual([]);
  });

  it("finds an approved requirement whose code changed but isn't named", () => {
    const r = report([], ["src/import/csv.ts", "README.md"]);
    expect(r.touched.map((x) => x.key)).toContain("REQ-0003");
    expect(r.gaps).toContainEqual({ type: "unnamed-approved-change", key: "REQ-0003", title: "Import templates", paths: ["src/import/csv.ts"] });
  });

  it("doesn't report an approved requirement that is named", () => {
    expect(report(["REQ-0003"], ["src/import/csv.ts"]).gaps.filter((g) => g.type === "unnamed-approved-change")).toEqual([]);
  });

  it("finds a touched high risk without mitigation", () => {
    expect(report([], ["src/import/map.ts"]).gaps).toContainEqual({ type: "unmitigated-high-risk", key: "RSK-0001", title: "Import maps columns to the wrong fields" });
  });

  it("leaves obsolete requirements out", () => {
    const c = items();
    c.requirements = c.requirements.map((r) => (r.id === "REQ-0003" ? { ...r, status: "obsolete" as const } : r));
    const r = report([], ["src/import/csv.ts"], c);
    expect(r.touched.map((x) => x.key)).not.toContain("REQ-0003");
  });

  it("writes a marked Markdown comment", () => {
    const r = report(["REQ-0002"], ["src/import/map.ts"]);
    expect(r.markdown.startsWith("<!-- groundwork -->")).toBe(true);
    expect(r.markdown).toContain("| REQ-0002 |");
    expect(r.markdown).toContain("### Gaps");
    expect(report([], []).markdown).toContain("No gaps found.");
  });

  it("escapes Markdown a requirement's title could inject into the table", () => {
    const c = items();
    c.requirements = c.requirements.map((r) => (r.id === "REQ-0002" ? { ...r, title: "Evil | ![x](https://evil.test/x.png)" } : r));
    const md = report(["REQ-0002"], [], c).markdown;
    expect(md).toContain("Evil \\| \\!\\[x\\]\\(https://evil.test/x.png\\)");
  });

  it("doesn't let a title mention people or hide a comment marker", () => {
    const c = items();
    c.requirements = c.requirements.map((r) => (r.id === "REQ-0002" ? { ...r, title: "Ping @acme/everyone <!-- groundwork -->" } : r));
    const md = report(["REQ-0002"], [], c).markdown;
    expect(md).not.toContain("@acme");
    expect(md).toContain("@\u200bacme/everyone");
    expect(md.indexOf("<!-- groundwork -->", 1)).toBe(-1);
  });
});

describe("prReport with this PR's test results", () => {
  function withTests() {
    const c = items();
    c.requirements = c.requirements.map((r) =>
      r.id === "REQ-0002"
        ? {
            ...r,
            codeTests: [
              { path: "test/import.test.ts", name: "maps columns", linkedAt: "", linkedBy: "" },
              { path: "test/import.test.ts", name: "keeps templates", linkedAt: "", linkedBy: "" },
            ],
          }
        : r,
    );
    return c;
  }
  const withResults = (results: CodeTestResult[] | undefined) => prReport({ keys: ["REQ-0002"], changedPaths: [], items: withTests(), matrix: defaultMatrix(), files, results });

  it("a named requirement's failing linked test is a gap", () => {
    const r = withResults([
      { path: "test/import.test.ts", name: "import > maps columns", status: "failed" },
      { path: "test/import.test.ts", name: "import > keeps templates", status: "passed" },
    ]);
    expect(r.gaps).toEqual([{ type: "failed-code-test", key: "REQ-0002", title: "Guided CSV import", tests: ["test/import.test.ts › maps columns"] }]);
  });

  it("a linked test missing from the results is code-tests-not-run", () => {
    const r = withResults([{ path: "test/import.test.ts", name: "maps columns", status: "passed" }]);
    expect(r.gaps).toEqual([{ type: "code-tests-not-run", key: "REQ-0002", title: "Guided CSV import", tests: ["test/import.test.ts › keeps templates"] }]);
  });

  it("a linked test whose file isn't in the results isn't claimed as not run", () => {
    expect(withResults([{ path: "test/other.test.ts", name: "x", status: "passed" }]).gaps).toEqual([]);
  });

  it("without results, no test-result gaps are claimed", () => {
    expect(withResults(undefined).gaps).toEqual([]);
  });
});
