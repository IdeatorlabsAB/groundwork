import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JunitError, parseJunit } from "../src/core/junit";
import { matchCodeTests } from "../src/core/match-tests";
import type { Requirement } from "../src/core/types";
import { ID, workspace } from "./fixtures";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/junit/${name}`, import.meta.url), "utf8");

describe("parseJunit", () => {
  it("reads vitest's report: path from classname, passed, failed and skipped", () => {
    expect(parseJunit(fixture("vitest.xml"))).toEqual([
      { path: "test/release.test.ts", name: "releaseReadiness > blocks an unmitigated high risk REQ-0042", status: "passed", durationMs: 12 },
      { path: "test/release.test.ts", name: "releaseReadiness > passes when mitigated", status: "failed", durationMs: 3 },
      { path: "test/release.test.ts", name: "releaseReadiness > later", status: "skipped", durationMs: 0 },
    ]);
  });

  it("counts an error as a failure and falls back to classname without a file", () => {
    expect(parseJunit(fixture("pytest.xml")).map((r) => [r.path, r.name, r.status])).toEqual([
      ["tests.test_billing", "test_discount", "passed"],
      ["tests.test_billing", "test_rounding", "failed"],
    ]);
  });

  it("flattens nested suites and prefers the file attribute, normalised", () => {
    // A suite's own cases come before its nested suites' cases; the order between them carries no meaning.
    expect(parseJunit(fixture("nested.xml")).map((r) => [r.path, r.name]).sort()).toEqual([
      ["src/a.test.ts", "works"],
      ["src/b.test.ts", "top"],
    ]);
  });

  it("refuses malformed XML with a readable message", () => {
    expect(() => parseJunit("<testsuite")).toThrow(JunitError);
    expect(() => parseJunit("<html><body>Not JUnit</body></html>")).toThrow(/testsuite/);
  });
});

describe("matchCodeTests", () => {
  const req = (tests: { path: string; name: string }[]): Requirement => ({
    ...workspace().requirements.find((r) => r.id === ID.solutionReq)!,
    // Local requirements are known by their id (REQ-0042); the web app's have a separate key.
    id: "REQ-0042",
    codeTests: tests.map((t) => ({ ...t, linkedAt: "", linkedBy: "" })),
  });

  it("matches a test by path and by name or full-title suffix, and reports linked tests that didn't run", () => {
    const results = parseJunit(fixture("vitest.xml"));
    expect(
      matchCodeTests(
        [req([
          { path: "test/release.test.ts", name: "blocks an unmitigated high risk REQ-0042" },
          { path: "./test/release.test.ts", name: "releaseReadiness > passes when mitigated" },
          { path: "test/release.test.ts", name: "gone" },
        ])],
        results,
      ),
    ).toEqual([
      { requirementKey: "REQ-0042", path: "test/release.test.ts", name: "blocks an unmitigated high risk REQ-0042", status: "passed" },
      { requirementKey: "REQ-0042", path: "./test/release.test.ts", name: "releaseReadiness > passes when mitigated", status: "failed" },
      { requirementKey: "REQ-0042", path: "test/release.test.ts", name: "gone", status: "not-run" },
    ]);
  });

  it("uses the latest result when a test ran more than once", () => {
    const r = matchCodeTests([req([{ path: "a.ts", name: "x" }])], [
      { path: "a.ts", name: "x", status: "failed" },
      { path: "a.ts", name: "x", status: "passed" },
    ]);
    expect(r[0].status).toBe("passed");
  });
});
