import type { Experiment, Finding, Hypothesis, Insight, Requirement } from "./types";

export interface Graph {
  insights: Insight[];
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  findings: Finding[];
  requirements: Requirement[];
}

export interface Trail {
  /** Solution requirements: the stakeholder requirements they help meet. */
  stakeholderRequirements: Requirement[];
  findings: Finding[];
  experiments: Experiment[];
  hypotheses: Hypothesis[];
  insights: Insight[];
}

/** Walk a requirement back to every piece of evidence behind it. */
export function trailForRequirement(r: Requirement, g: Graph): Trail {
  const stakeholderRequirements = g.requirements.filter((x) => r.stakeholderIds?.includes(x.id));
  const findings = g.findings.filter((f) => r.findingIds.includes(f.id));
  const experiments = g.experiments.filter((e) => findings.some((f) => f.experimentIds.includes(e.id)));
  const hypIds = new Set([
    ...findings.flatMap((f) => f.hypothesisIds),
    ...experiments.map((e) => e.hypothesisId),
    ...(r.hypothesisIds ?? []),
  ]);
  const hypotheses = g.hypotheses.filter((h) => hypIds.has(h.id));
  const insIds = new Set([
    ...findings.flatMap((f) => f.insightIds),
    ...hypotheses.flatMap((h) => h.insightIds),
    ...(r.insightIds ?? []),
  ]);
  const insights = g.insights.filter((i) => insIds.has(i.id));
  return { stakeholderRequirements, findings, experiments, hypotheses, insights };
}

/** All node ids connected (upstream and downstream) to a given node. */
export function connectedIds(id: string, g: Graph): Set<string> {
  const edges: [string, string][] = [];
  g.hypotheses.forEach((h) => h.insightIds.forEach((i) => edges.push([i, h.id])));
  g.experiments.forEach((e) => edges.push([e.hypothesisId, e.id]));
  g.findings.forEach((f) => {
    f.experimentIds.forEach((e) => edges.push([e, f.id]));
    if (!f.experimentIds.length) f.hypothesisIds.forEach((h) => edges.push([h, f.id]));
  });
  g.requirements.forEach((r) => {
    r.findingIds.forEach((f) => edges.push([f, r.id]));
    // Directly created requirements link straight to their evidence and source hypotheses.
    r.insightIds?.forEach((i) => edges.push([i, r.id]));
    r.hypothesisIds?.forEach((h) => edges.push([h, r.id]));
    // Solution requirements meet stakeholder requirements.
    r.stakeholderIds?.forEach((s) => edges.push([s, r.id]));
  });

  const result = new Set<string>([id]);
  // upstream
  const up = [id];
  while (up.length) {
    const cur = up.pop()!;
    edges.forEach(([a, b]) => {
      if (b === cur && !result.has(a)) {
        result.add(a);
        up.push(a);
      }
    });
  }
  // downstream
  const down = [id];
  const seenDown = new Set([id]);
  while (down.length) {
    const cur = down.pop()!;
    edges.forEach(([a, b]) => {
      if (a === cur && !seenDown.has(b)) {
        seenDown.add(b);
        result.add(b);
        down.push(b);
      }
    });
  }
  return result;
}

export function evidenceStrength(t: Trail): { score: number; label: "Strong" | "Moderate" | "Weak" } {
  const validated = t.experiments.filter((e) => e.verdict === "validated").length;
  const invalidated = t.experiments.filter((e) => e.verdict === "invalidated").length;
  const score = Math.min(100, t.insights.length * 8 + validated * 35 + invalidated * 20 + t.findings.length * 10);
  return { score, label: score >= 70 ? "Strong" : score >= 40 ? "Moderate" : "Weak" };
}
