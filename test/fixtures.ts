import { emptyCollections, type Collections } from "../src/core/collections";
import type { Ctx } from "../src/core/ops";
import type { Experiment, Finding, Hypothesis, Insight, Requirement } from "../src/core/types";

export const ID = {
  insight: "00000000-0000-4000-8000-000000000001",
  insight2: "00000000-0000-4000-8000-000000000002",
  hypothesis: "00000000-0000-4000-8000-000000000010",
  experiment: "00000000-0000-4000-8000-000000000020",
  finding: "00000000-0000-4000-8000-000000000030",
  stakeholderReq: "00000000-0000-4000-8000-000000000040",
  solutionReq: "00000000-0000-4000-8000-000000000041",
  approvedReq: "00000000-0000-4000-8000-000000000042",
};

export const USER = "00000000-0000-4000-8000-0000000000aa";
export const OTHER_USER = "00000000-0000-4000-8000-0000000000bb";
export const AREA = "area-onboarding";

let n = 0;
export function ctx(over: Partial<Ctx> = {}): Ctx {
  return { actor: USER, now: "2026-11-18T10:00:00.000Z", newId: () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`, ...over };
}

export function workspace(): Collections {
  const insight: Insight = {
    id: ID.insight,
    title: "Setup takes too long",
    quote: "I gave up on the import after twenty minutes.",
    source: "interview",
    persona: "Ops lead",
    tags: ["onboarding"],
    sentiment: "negative",
    productArea: AREA,
    createdAt: "2026-11-01T00:00:00.000Z",
    createdBy: USER,
  };
  const insight2: Insight = { ...insight, id: ID.insight2, title: "Import errors are unclear", productArea: AREA };
  const hypothesis: Hypothesis = {
    id: ID.hypothesis,
    title: "Guided import",
    outcome: "raise week-1 activation",
    forWhom: "new ops leads",
    benefit: "a working workspace in 5 minutes",
    feature: "a guided CSV import",
    knowWhen: "",
    status: "draft",
    productArea: AREA,
    confidence: 50,
    insightIds: [ID.insight],
    owner: USER,
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  };
  const experiment: Experiment = {
    id: ID.experiment,
    hypothesisId: ID.hypothesis,
    title: "Guided import pilot",
    method: "pilot",
    description: "10 new accounts get the guided import.",
    primaryMetric: { name: "Activation", unit: "%", baseline: 38, target: 55, direction: "increase" },
    guardrails: [{ name: "Support tickets", unit: "tickets", baseline: 10, target: 12, direction: "decrease" }],
    sampleSize: "10 accounts",
    durationWeeks: 2,
    status: "planned",
    owner: USER,
  };
  const finding: Finding = {
    id: ID.finding,
    title: "Guided import lifts activation",
    summary: "Activation rose to 61%.",
    experimentIds: [ID.experiment],
    hypothesisIds: [ID.hypothesis],
    insightIds: [ID.insight],
    confidence: "high",
    productArea: AREA,
    createdAt: "2026-11-10T00:00:00.000Z",
  };
  const stakeholderReq: Requirement = {
    id: ID.stakeholderReq,
    kind: "stakeholder",
    title: "Ops leads need to be set up on day one",
    story: "As an ops lead I want a working workspace on my first day so that my team can start straight away.",
    stakeholder: "Ops leads",
    acceptanceCriteria: ["Setup under 10 minutes"],
    priority: "must",
    status: "draft",
    findingIds: [ID.finding],
    createdAt: "2026-11-11T00:00:00.000Z",
  };
  const solutionReq: Requirement = {
    ...stakeholderReq,
    id: ID.solutionReq,
    kind: "solution",
    title: "Guided CSV import",
    story: "The import shall guide the user through mapping columns and fixing errors.",
    stakeholder: undefined,
    stakeholderIds: [ID.stakeholderReq],
    status: "awaiting-approval",
    approver: USER,
  };
  const approvedReq: Requirement = { ...solutionReq, id: ID.approvedReq, title: "Import templates", status: "approved", approver: OTHER_USER };
  return {
    ...emptyCollections(),
    insights: [insight, insight2],
    hypotheses: [hypothesis],
    experiments: [experiment],
    findings: [finding],
    requirements: [stakeholderReq, solutionReq, approvedReq],
  };
}
