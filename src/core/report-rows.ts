// Ported from centropic-prototype src/lib/reports.ts (traceabilityRows, riskRegisterRows, toCsv). Keep in step with it.
import { kindOf } from "./requirements";
import type { RequirementTestStatus } from "./tests";
import type { Requirement, Risk, RiskLevel, RiskMatrix, Ticket } from "./types";

/**
 * The release report's tables, derived from a version's sign-off record (or the same structure built from the current
 * files for a version that isn't signed off), so they're as frozen as the record.
 */

export interface RowsInput {
  version: string;
  kind: "release" | "baseline";
  matrix: RiskMatrix;
  requirements: Pick<Requirement, "id" | "title" | "kind" | "story" | "status" | "stakeholderIds" | "riskIds" | "tickets" | "plannedFor" | "releasedIn" | "codeRefs">[];
  risks: (Risk & { mitigated: boolean })[];
  tests?: { requirements: Record<string, RequirementTestStatus> };
}

const LEVEL: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };
const STATUS: Record<string, string> = { draft: "Draft", "awaiting-approval": "Waiting for approval", approved: "Approved", "in-delivery": "In delivery", obsolete: "Obsolete" };
const FAILED: readonly string[] = ["failed", "blocked", "invalid"];
const NONE = "None";
const list = (xs: string[]) => (xs.length ? xs.join(", ") : NONE);
const isPullRequest = (t: Ticket) => (t.url ? /\/(pull|pull-requests|merge_requests)\/\d+/.test(t.url) : /[#!]\d+$/.test(t.key) && (t.tracker === "github" || t.tracker === "gitlab"));
const prState = (t: Ticket) => (t.state?.toLowerCase() === "merged" || t.done ? "merged" : t.state?.toLowerCase() === "closed" ? "closed" : "open");
const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export interface TraceabilityRow {
  key: string;
  title: string;
  kind: string;
  status: string;
  statement: string;
  /** Solution: the stakeholder requirements it fulfils. Stakeholder: "Fulfilled by …". */
  fulfils: string;
  risks: string;
  versions: string;
  /** Tickets in any tracker other than pull requests, with their state. */
  tasks: string;
  tests: string;
  pullRequests: string;
  codeRefs: string;
}

export const TRACEABILITY_COLUMNS: { key: keyof TraceabilityRow; label: string }[] = [
  { key: "key", label: "Key" },
  { key: "title", label: "Title" },
  { key: "kind", label: "Kind" },
  { key: "status", label: "Status" },
  { key: "statement", label: "Statement" },
  { key: "fulfils", label: "Fulfils" },
  { key: "risks", label: "Risks" },
  { key: "versions", label: "Versions" },
  { key: "tasks", label: "Tasks" },
  { key: "tests", label: "Tests" },
  { key: "pullRequests", label: "Pull requests" },
  { key: "codeRefs", label: "Code" },
];

/** The version's solution requirements: new in it (shipped in it, or planned for it while it isn't released). */
export const inVersion = (version: string) => (r: RowsInput["requirements"][number]) =>
  kindOf(r) === "solution" && (r.releasedIn === version || (!r.releasedIn && r.status !== "obsolete" && r.plannedFor === version));

/** The version's solution requirements and the stakeholder requirements they fulfil. Keys order. */
export function traceabilityRows(input: RowsInput): TraceabilityRow[] {
  const solutions = input.requirements.filter(inVersion(input.version));
  const needs = input.requirements.filter((r) => kindOf(r) === "stakeholder" && solutions.some((s) => s.stakeholderIds?.includes(r.id)));
  const row = (r: RowsInput["requirements"][number]): TraceabilityRow => {
    const stakeholder = kindOf(r) === "stakeholder";
    let testsText = "Not tested directly";
    if (!stakeholder) {
      const t = input.tests?.requirements[r.id];
      if (!input.tests) testsText = input.kind === "baseline" ? "Not checked (baseline)" : "Not checked";
      else {
        const outcomes = [...(t?.codeTests ?? []).map((x) => x.status), ...(t?.cases ?? []).map((x) => x.status)];
        const passed = outcomes.filter((x) => x === "passed").length;
        const failed = outcomes.filter((x) => FAILED.includes(x)).length;
        const notRun = outcomes.length - passed - failed;
        testsText = outcomes.length ? `${passed} of ${outcomes.length} passed${failed ? `, ${failed} failed` : ""}${notRun ? `, ${notRun} not run` : ""}` : "No tests linked";
      }
    }
    const tickets = r.tickets ?? [];
    return {
      key: r.id,
      title: r.title,
      kind: stakeholder ? "Stakeholder" : "Solution",
      status: STATUS[r.status] ?? r.status,
      statement: r.story,
      fulfils: stakeholder ? `Fulfilled by ${list(solutions.filter((s) => s.stakeholderIds?.includes(r.id)).map((s) => s.id).sort())}` : list([...(r.stakeholderIds ?? [])].sort()),
      risks: list(input.risks.filter((x) => x.mitigationIds.includes(r.id)).map((x) => x.id).sort()),
      versions: stakeholder ? NONE : list([r.releasedIn ?? r.plannedFor].filter((v): v is string => !!v)),
      tasks: list(tickets.filter((t) => !isPullRequest(t)).map((t) => `${t.tracker} ${t.key}${t.state ? ` (${t.state})` : ""}`)),
      tests: testsText,
      pullRequests: list(tickets.filter(isPullRequest).map((t) => `${t.key} (${prState(t)})`)),
      codeRefs: list(r.codeRefs ?? []),
    };
  };
  return [...needs, ...solutions].map(row).sort(byKey);
}

export interface RiskRegisterRow {
  key: string;
  title: string;
  hazard: string;
  harm: string;
  initial: string;
  initialLevel: string;
  residual: string;
  residualLevel: string;
  mitigations: string;
  /** Yes: no longer high on approved, and in this version tested, controls. */
  controlled: string;
  versions: string;
}

export const RISK_COLUMNS: { key: keyof RiskRegisterRow; label: string }[] = [
  { key: "key", label: "Key" },
  { key: "title", label: "Title" },
  { key: "hazard", label: "Hazard" },
  { key: "harm", label: "Harm" },
  { key: "initial", label: "Initial score" },
  { key: "initialLevel", label: "Initial level" },
  { key: "residual", label: "Residual score" },
  { key: "residualLevel", label: "Residual level" },
  { key: "mitigations", label: "Mitigations" },
  { key: "controlled", label: "Controlled" },
  { key: "versions", label: "Versions" },
];

/** The version's risks, scored on the record's matrix, with whether each was controlled as of sign-off. */
export function riskRegisterRows(input: RowsInput): RiskRegisterRow[] {
  const m = input.matrix;
  const level = (p?: number, s?: number) => {
    const l = p && s && p <= m.size && s <= m.size ? m.cells[p - 1][s - 1] : null;
    return l ? LEVEL[l] : "Not scored";
  };
  const score = (p?: number, s?: number) => (p && s ? `${m.probabilityLabels[p - 1] ?? p} × ${m.severityLabels[s - 1] ?? s}` : "Not scored");
  return input.risks
    .map((r) => {
      const initial = level(r.probability, r.severity);
      return {
        key: r.id,
        title: r.title,
        hazard: r.hazard,
        harm: r.harm,
        initial: score(r.probability, r.severity),
        initialLevel: initial,
        residual: score(r.residualProbability, r.residualSeverity),
        residualLevel: level(r.residualProbability, r.residualSeverity),
        mitigations: list(
          r.mitigationIds.map((id) => {
            const req = input.requirements.find((x) => x.id === id);
            return req ? `${req.id} (${STATUS[req.status] ?? req.status})` : "a deleted requirement";
          }),
        ),
        controlled: initial !== "High" && initial !== "Not scored" ? `Not needed (${initial})` : r.mitigated ? "Yes" : "No",
        versions: list(r.versions),
      };
    })
    .sort(byKey);
}

/**
 * Rows as CSV (RFC 4180, CRLF line ends). Cells starting with = + - @ get a leading apostrophe, so a spreadsheet
 * shows them as text instead of running them as formulas.
 */
export function toCsv<K extends string>(columns: { key: K; label: string }[], rows: Record<K, string>[]): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.map((c) => cell(c.label)), ...rows.map((r) => columns.map((c) => cell(r[c.key] ?? "")))].map((line) => line.join(",")).join("\r\n") + "\r\n";
}
