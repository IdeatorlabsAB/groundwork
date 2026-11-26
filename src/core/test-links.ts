import { kindOf } from "./requirements";
import type { CodeTestLink, Requirement, TestCaseLink } from "./types";

/**
 * Identity of tests linked to requirements. The same rules live in centropic-prototype src/lib/test-links.ts; keep the
 * two in step (see test/fixtures/parity/test-cases.json).
 */

type CaseRef = Pick<TestCaseLink, "tool" | "id"> & { project?: string };

/** A test case is the same case when tool, project and id match, ignoring case. */
export const caseKey = (t: CaseRef): string => [t.tool.toLowerCase(), (t.project ?? "").toUpperCase(), t.id.toUpperCase()].join("\u0000");

export const sameCase = (a: CaseRef, b: CaseRef) => caseKey(a) === caseKey(b);

export const sameCodeTest = (a: Pick<CodeTestLink, "path" | "name">, b: Pick<CodeTestLink, "path" | "name">) => a.path === b.path && a.name === b.name;

/** Solution requirements that can still change take tests. Tests are written while it's built, so in delivery still does. */
export const takesTests = (r: Requirement) => kindOf(r) === "solution" && r.status !== "obsolete";
