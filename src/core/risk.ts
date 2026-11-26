// Ported from centropic-prototype src/lib/risk.ts. Keep in step with it (see test/fixtures/parity).
import type { Requirement, RequirementStatus, Risk, RiskLevel, RiskMatrix } from "./types";

/**
 * Risk scoring: probability × severity on the workspace's matrix. Pure, so the browser, the server's
 * release gate and agents all score the same way.
 */

const LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

const LABELS = {
  5: {
    probability: ["Rare", "Unlikely", "Possible", "Likely", "Almost certain"],
    severity: ["Negligible", "Minor", "Moderate", "Major", "Catastrophic"],
  },
  3: { probability: ["Low", "Medium", "High"], severity: ["Low", "Medium", "High"] },
} as const;

/** The level for a score of p × s on the default grids. */
function defaultLevel(size: 3 | 5, score: number): RiskLevel {
  if (size === 5) return score >= 15 ? "high" : score >= 5 ? "medium" : "low";
  return score >= 6 ? "high" : score >= 3 ? "medium" : "low";
}

export function defaultMatrix(size: 3 | 5 = 5): RiskMatrix {
  const steps = Array.from({ length: size }, (_, i) => i + 1);
  return {
    size,
    probabilityLabels: [...LABELS[size].probability],
    severityLabels: [...LABELS[size].severity],
    cells: steps.map((p) => steps.map((s) => defaultLevel(size, p * s))),
  };
}

export function isValidMatrix(m: unknown): m is RiskMatrix {
  if (!m || typeof m !== "object") return false;
  const x = m as Partial<RiskMatrix>;
  if (x.size !== 3 && x.size !== 5) return false;
  const n = x.size;
  const labels = (l: unknown) => Array.isArray(l) && l.length === n && l.every((v) => typeof v === "string");
  return (
    labels(x.probabilityLabels) &&
    labels(x.severityLabels) &&
    Array.isArray(x.cells) &&
    x.cells.length === n &&
    x.cells.every((row) => Array.isArray(row) && row.length === n && row.every((c) => LEVELS.includes(c)))
  );
}

const inRange = (m: RiskMatrix, v: number | undefined): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= m.size;

/** The level for probability p and severity s, or null when the matrix can't place them. */
export function riskLevel(m: RiskMatrix, p: number | undefined, s: number | undefined): RiskLevel | null {
  return inRange(m, p) && inRange(m, s) ? m.cells[p - 1][s - 1] : null;
}

export const initialLevel = (m: RiskMatrix, r: Risk) => riskLevel(m, r.probability, r.severity);
export const residualLevel = (m: RiskMatrix, r: Risk) => riskLevel(m, r.residualProbability, r.residualSeverity);

/** Requirement statuses that count as a documented, signed-off control. */
export const MITIGATION_OK: RequirementStatus[] = ["approved", "in-delivery"];

/**
 * A risk that isn't high is acceptable as is. A high one is mitigated when its residual score is no longer
 * high and every mitigating requirement exists and is signed off (and, when `isTested` is given, tested).
 */
export function isMitigated(m: RiskMatrix, r: Risk, requirements: Requirement[], isTested?: (req: Requirement) => boolean): boolean {
  if (initialLevel(m, r) !== "high") return initialLevel(m, r) !== null;
  const residual = residualLevel(m, r);
  if (!residual || residual === "high" || !r.mitigationIds.length) return false;
  return r.mitigationIds.every((id) => {
    const req = requirements.find((x) => x.id === id);
    return !!req && MITIGATION_OK.includes(req.status) && (!isTested || isTested(req));
  });
}
