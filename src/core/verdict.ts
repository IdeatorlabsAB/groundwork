import type { Experiment, Metric, Verdict } from "./types";

export function metricPasses(m: Metric): boolean | undefined {
  if (m.actual === undefined || m.actual === null || Number.isNaN(m.actual)) return undefined;
  return m.direction === "decrease" ? m.actual <= m.target : m.actual >= m.target;
}

export interface VerdictResult {
  verdict: Verdict;
  reason: string;
}

/** The heart of the experiment loop: compare results against the success criteria. */
export function computeVerdict(exp: Experiment): VerdictResult {
  const primary = metricPasses(exp.primaryMetric);
  if (primary === undefined) {
    return { verdict: "inconclusive", reason: "No result recorded for the primary metric yet." };
  }
  const failedGuardrails = exp.guardrails.filter((g) => metricPasses(g) === false);
  if (!primary) {
    return {
      verdict: "invalidated",
      reason: `${exp.primaryMetric.name} did not reach the target (${fmtMetric(exp.primaryMetric, exp.primaryMetric.actual!)} vs target ${targetLabel(exp.primaryMetric)}).`,
    };
  }
  if (failedGuardrails.length > 0) {
    return {
      verdict: "invalidated",
      reason: `Primary metric hit target, but guardrail breached: ${failedGuardrails.map((g) => g.name).join(", ")}.`,
    };
  }
  return {
    verdict: "validated",
    reason: `${exp.primaryMetric.name} hit target (${fmtMetric(exp.primaryMetric, exp.primaryMetric.actual!)} vs target ${targetLabel(exp.primaryMetric)}) and all guardrails held.`,
  };
}

export function fmtMetric(m: Metric, v: number) {
  const n = Number.isInteger(v) ? v.toString() : v.toFixed(1);
  return m.unit === "%" ? `${n}%` : `${n} ${m.unit}`;
}

export function targetLabel(m: Metric) {
  return `${m.direction === "decrease" ? "≤" : "≥"} ${fmtMetric(m, m.target)}`;
}
