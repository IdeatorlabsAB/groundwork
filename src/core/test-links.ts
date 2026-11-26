import { kindOf } from "./requirements";
import type { CodeTestLink, Requirement, TestCaseLink } from "./types";

/**
 * Identity of tests linked to requirements. The same rules live in centropic-prototype src/lib/test-links.ts; keep the
 * two in step (see test/fixtures/parity/test-cases.json).
 */

type CaseRef = Pick<TestCaseLink, "tool" | "id"> & { project?: string };

/** A test case is the same case when tool, project and id match, ignoring case. */
// Defensive about hand-written files: an unquoted `id: 12` or `project: 7` reads as a number, and must not throw.
export const caseKey = (t: CaseRef): string => [String(t.tool ?? "").toLowerCase(), String(t.project ?? "").toUpperCase(), String(t.id ?? "").toUpperCase()].join("\u0000");

export const sameCase = (a: CaseRef, b: CaseRef) => caseKey(a) === caseKey(b);

export const sameCodeTest = (a: Pick<CodeTestLink, "path" | "name">, b: Pick<CodeTestLink, "path" | "name">) => a.path === b.path && a.name === b.name;

/** Solution requirements that can still change take tests. Tests are written while it's built, so in delivery still does. */
export const takesTests = (r: Requirement) => kindOf(r) === "solution" && r.status !== "obsolete";

/** "qase ACME-12", "testrail C5": how tools and messages name a case. */
export const caseLabel = (t: CaseRef) => `${t.tool} ${t.project ? `${t.project}-` : ""}${t.id}`;
