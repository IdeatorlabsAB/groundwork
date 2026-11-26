import { describe, expect, it } from "vitest";
import { describeUntested, testStatus as judge } from "../src/core/tests";
import type { Requirement, TestResult, TestResults } from "../src/core/types";
import { ID, workspace } from "./fixtures";

// Ported from centropic-prototype test/tests.test.ts: test-management cases only, no code tests, no CI runs.
const testStatus = (r: Requirement, results: TestResult[]) => judge(r, { results, code: { runs: [], results: [] } } satisfies Pick<TestResults, "results" | "code">);

const req = (caseIds: number[]): Requirement => ({
  ...workspace().requirements.find((r) => r.id === ID.approvedReq)!,
  testCases: caseIds.map((id) => ({ tool: "qase", project: "ACME", id: String(id), title: `Case ${id}`, linkedAt: "", linkedBy: "" })),
});
const res = (id: number, status: TestResult["status"], endTime: string | null, runId = 1, tool = "qase", project = "ACME"): TestResult => ({
  tool,
  project,
  id: String(id),
  runId: String(runId),
  status,
  endTime,
});

describe("testStatus", () => {
  it("no cases and no code tests → no-tests", () => {
    expect(testStatus(req([]), [])).toEqual({ status: "no-tests", cases: [], codeTests: [] });
    expect(testStatus({ ...req([]), testCases: undefined }, []).status).toBe("no-tests");
  });

  it("failed in run 1, passed in a later run 2 → passed", () => {
    const t = testStatus(req([12]), [res(12, "failed", "2026-11-20T10:00:00+00:00", 1), res(12, "passed", "2026-11-21T10:00:00+00:00", 2)]);
    expect(t).toEqual({ status: "passed", cases: [{ tool: "qase", project: "ACME", id: "12", title: "Case 12", status: "passed", runId: "2", endTime: "2026-11-21T10:00:00+00:00" }], codeTests: [] });
  });

  it("passed, then failed later → failed", () => {
    expect(testStatus(req([12]), [res(12, "passed", "2026-11-20T10:00:00+00:00"), res(12, "failed", "2026-11-22T10:00:00+00:00")]).status).toBe("failed");
  });

  it("compares end times as instants, not strings", () => {
    expect(testStatus(req([12]), [res(12, "failed", "2026-11-20T10:00:00+00:00"), res(12, "passed", "2026-11-20T11:00:00+02:00")]).status).toBe("failed");
  });

  it("in_progress (endTime null) → not-run", () => {
    expect(testStatus(req([12]), [res(12, "in_progress", null)]).cases[0].status).toBe("not-run");
  });

  it("one of two cases not run → not-run", () => {
    expect(testStatus(req([12, 13]), [res(12, "passed", "2026-11-20T10:00:00+00:00")]).status).toBe("not-run");
  });

  it("blocked, skipped and invalid don't count as passed", () => {
    expect(testStatus(req([12]), [res(12, "blocked", "2026-11-20T10:00:00+00:00")]).status).toBe("failed");
    expect(testStatus(req([12]), [res(12, "invalid", "2026-11-20T10:00:00+00:00")]).status).toBe("failed");
    expect(testStatus(req([12]), [res(12, "skipped", "2026-11-20T10:00:00+00:00")]).status).toBe("not-run");
  });

  it("a result from another project doesn't count", () => {
    expect(testStatus(req([12]), [res(12, "passed", "2026-11-20T10:00:00+00:00", 1, "qase", "OLD")]).status).toBe("not-run");
  });

  it("a TestRail result doesn't pass a Qase case with the same id", () => {
    expect(testStatus(req([12]), [res(12, "passed", "2026-11-20T10:00:00+00:00", 1, "testrail")]).status).toBe("not-run");
  });

  it("code tests count with the cases", () => {
    const r = { ...req([12]), codeTests: [{ path: "test/a.test.ts", name: "a", linkedAt: "", linkedBy: "" }] };
    const code = { runs: [], results: [{ path: "test/a.test.ts", name: "suite > a", status: "failed" as const, runId: "r", commitSha: "c", at: "x" }] };
    expect(judge(r, { results: [res(12, "passed", "2026-11-20T10:00:00+00:00")], code }).status).toBe("failed");
  });
});

describe("describeUntested", () => {
  it("describeUntested labels cases from any tool", () => {
    const r = { ...req([12]), testCases: [{ tool: "testrail", id: "C5", title: "Rail", linkedAt: "", linkedBy: "" }, ...req([12]).testCases!] };
    expect(describeUntested(testStatus(r, [res(12, "failed", "2026-11-20T10:00:00+00:00")]))).toBe("C5 not run, ACME-12 failed");
  });
});
