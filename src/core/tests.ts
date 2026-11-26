// Ported from centropic-prototype src/lib/tests.ts. Keep in step with it.
import { isRunOf } from "./match-tests";
import type { CodeTestStatus } from "./junit";
import { caseKey, caseRef } from "./test-links";
import type { Requirement, TestResult, TestResultStatus, TestResults } from "./types";

/**
 * Whether a requirement's tests passed: its linked cases in any test-management tool and its linked code tests. Per
 * case (tool + project + id), the latest finished result across the version's runs counts; per code test, its result
 * in the newest default-branch CI run that contains it.
 */

export interface CaseOutcome {
  tool: string;
  project?: string;
  id: string;
  title: string;
  status: TestResultStatus | "not-run";
  runId?: string;
  endTime?: string;
}

/** A linked code test's latest result on the default branch, with the CI run and commit it came from. */
export interface CodeTestOutcome {
  path: string;
  name: string;
  /** "not-run" when no default-branch run read contains it. */
  status: CodeTestStatus | "not-run";
  runId?: string;
  commitSha?: string;
}

export interface RequirementTestStatus {
  /** passed: every linked case and code test passed. no-tests: nothing is linked. */
  status: "passed" | "failed" | "not-run" | "no-tests";
  cases: CaseOutcome[];
  codeTests: CodeTestOutcome[];
}

const FAILED: readonly string[] = ["failed", "blocked", "invalid"];

export function testStatus(r: Pick<Requirement, "testCases" | "codeTests">, tests: Pick<TestResults, "results" | "code">): RequirementTestStatus {
  const cases = caseOutcomes(r, tests.results);
  const codeTests = (r.codeTests ?? []).map((t): CodeTestOutcome => {
    const hit = tests.code.results.find((x) => isRunOf(t, x));
    return hit ? { path: t.path, name: t.name, status: hit.status, runId: hit.runId, commitSha: hit.commitSha } : { path: t.path, name: t.name, status: "not-run" };
  });
  const all = [...cases.map((c) => c.status), ...codeTests.map((c) => c.status)];
  if (!all.length) return { status: "no-tests", cases, codeTests };
  const status = all.some((x) => FAILED.includes(x)) ? "failed" : all.every((x) => x === "passed") ? "passed" : "not-run";
  return { status, cases, codeTests };
}

function caseOutcomes(r: Pick<Requirement, "testCases">, results: TestResult[]): CaseOutcome[] {
  // The latest finished result per case. A result without an end time is still in progress: no outcome yet.
  const latest = new Map<string, TestResult>();
  for (const x of results) {
    if (!x.endTime) continue;
    const k = caseKey(x);
    const was = latest.get(k);
    if (!was || Date.parse(x.endTime) > Date.parse(was.endTime!)) latest.set(k, x);
  }
  return (r.testCases ?? []).map((t): CaseOutcome => {
    const base = { tool: t.tool, ...(t.project ? { project: t.project } : {}), id: t.id, title: t.title };
    const hit = latest.get(caseKey(t));
    if (!hit || hit.status === "skipped" || hit.status === "in_progress") return { ...base, status: "not-run" };
    return { ...base, status: hit.status, runId: hit.runId, endTime: hit.endTime! };
  });
}

/** "ACME-12 failed, C5 not run": the cases that keep a requirement from counting as tested. Same wording as the web app. */
export function describeUntested(t: RequirementTestStatus): string {
  return t.cases
    .filter((c) => c.status !== "passed")
    .map((c) => `${caseRef(c)} ${c.status === "not-run" ? "not run" : c.status}`)
    .join(", ");
}
