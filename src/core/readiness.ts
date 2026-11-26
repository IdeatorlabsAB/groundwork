// Ported from centropic-prototype src/lib/release.ts. Keep in step with it (see test/fixtures/parity/readiness.json).
import { kindOf } from "./requirements";
import { initialLevel, isMitigated, MITIGATION_OK, residualLevel } from "./risk";
import { describeUntested, testStatus, type RequirementTestStatus } from "./tests";
import type { Blocker, Requirement, Risk, RiskMatrix, TestResults } from "./types";

/**
 * Release readiness: what has to be true before a product version goes out. The web app scopes by a release entity;
 * locally a version's scope is worked out by the store (versionScope) and passed in, so both judge the same way.
 */

export interface Scope {
  /** Requirements new in the version. */
  requirements: Requirement[];
  /** Risks tagged for the version. */
  risks: Risk[];
}

/**
 * How the version's tests are judged. `undefined`: not checked. `null`: they couldn't be judged, so nothing counts as
 * tested. Otherwise: the version's results (see resultsFor).
 */
export type Tests = TestResults | null | undefined;

const signedOff = (r: Requirement | undefined) => !!r && MITIGATION_OK.includes(r.status);

/** Whether a requirement must pass its tests for this version: solution requirements new in it. */
const testedIn = (scope: Scope, r: Requirement) => kindOf(r) === "solution" && scope.requirements.some((x) => x.id === r.id);

function verdict(scope: Scope, r: Requirement, tests: Tests): RequirementTestStatus | null | undefined {
  if (tests === undefined || !testedIn(scope, r)) return undefined;
  return tests === null ? null : testStatus(r, tests);
}

/** For isMitigated: whether a mitigating requirement passes this version's tests. Undefined when tests aren't checked. */
export function mitigationTested(scope: Scope, tests: Tests): ((r: Requirement) => boolean) | undefined {
  if (tests === undefined) return undefined;
  return (r) => {
    const v = verdict(scope, r, tests);
    return v === undefined || v?.status === "passed";
  };
}

/** isMitigated with this version's test check. */
export const mitigatedIn = (m: RiskMatrix, risk: Risk, all: Requirement[], scope: Scope, tests: Tests) => isMitigated(m, risk, all, mitigationTested(scope, tests));

function riskBlockers(m: RiskMatrix, risk: Risk, requirements: Requirement[], scope: Scope, tests: Tests): Blocker[] {
  const name = `Risk "${risk.title}"`;
  const level = initialLevel(m, risk);
  if (!level) return [{ type: "unscored-risk", refId: risk.id, message: `${name} has a score the risk matrix can't place` }];
  if (level !== "high") return [];
  if (!risk.mitigationIds.length) return [{ type: "missing-mitigation", refId: risk.id, message: `${name} has no mitigating requirement` }];
  const bad = risk.mitigationIds.filter((id) => !signedOff(requirements.find((r) => r.id === id)));
  if (bad.length) {
    return bad.map((id) => {
      const req = requirements.find((r) => r.id === id);
      const what = req ? `"${req.title}" isn't approved` : "was deleted";
      return { type: "unapproved-mitigation", refId: risk.id, message: `${name}: mitigating requirement ${what}` };
    });
  }
  const residual = residualLevel(m, risk);
  if (!residual || residual === "high") {
    const why = residual ? "is still high" : "hasn't been scored";
    return [{ type: "unmitigated-risk", refId: risk.id, message: `${name}: residual risk ${why}` }];
  }
  // A mitigation shipping in this version only counts once its tests passed.
  return risk.mitigationIds.flatMap((id): Blocker[] => {
    const req = requirements.find((r) => r.id === id)!;
    const v = verdict(scope, req, tests);
    return v === undefined || v?.status === "passed"
      ? []
      : [{ type: "untested-mitigation", refId: risk.id, message: `${name}: mitigating requirement "${req.title}" isn't tested` }];
  });
}

const testLabel = (t: { path: string; name: string }) => `${t.path} › ${t.name}`;

function testBlockers(scope: Scope, r: Requirement, tests: Tests): Blocker[] {
  const v = verdict(scope, r, tests);
  if (v === undefined || v?.status === "passed") return [];
  const name = `Requirement "${r.title}"`;
  if (v === null) return [{ type: "untested-requirement", refId: r.id, message: `${name}: couldn't judge its tests` }];
  if (v.status === "no-tests") return [{ type: "missing-tests", refId: r.id, message: `${name} has no linked tests` }];
  const code = v.codeTests ?? [];
  const failed = code.filter((t) => t.status === "failed");
  // Skipped counts as not run: it didn't show the requirement works.
  const notRun = code.filter((t) => t.status === "not-run" || t.status === "skipped");
  const out: Blocker[] = [];
  if (failed.length) out.push({ type: "failed-code-test", refId: r.id, message: `${name}: code tests failed in CI: ${failed.map(testLabel).join(", ")}` });
  if (notRun.length) {
    out.push({ type: "no-ci-run", refId: r.id, message: `${name}: code tests haven't run in CI on the default branch: ${notRun.map(testLabel).join(", ")}` });
  }
  if (v.cases.some((c) => c.status !== "passed")) {
    out.push({ type: "untested-requirement", refId: r.id, message: `${name} isn't tested: ${describeUntested(v)}` });
  }
  return out;
}

/** What stops the version going out. `all` holds every requirement, so mitigations outside the scope are found. */
export function releaseReadiness(m: RiskMatrix, scope: Scope, all: Requirement[], tests: Tests): { ok: boolean; blockers: Blocker[] } {
  const blockers = [
    ...scope.risks.flatMap((r) => riskBlockers(m, r, all, scope, tests)),
    ...scope.requirements
      .filter((r) => !signedOff(r))
      .map((r): Blocker => ({ type: "unapproved-requirement", refId: r.id, message: `Requirement "${r.title}" isn't approved` })),
    ...scope.requirements.flatMap((r) => testBlockers(scope, r, tests)),
  ];
  return { ok: blockers.length === 0, blockers };
}
