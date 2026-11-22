import { canObsolete, kindOf, type RequirementChanges } from "./requirements";
import type {
  Activity,
  Delivery,
  Experiment,
  Finding,
  Hypothesis,
  Insight,
  Metric,
  Prioritization,
  ProductArea,
  Requirement,
} from "./types";
import { computeVerdict, type VerdictResult } from "./verdict";
import type { Collections } from "./collections";

/**
 * Every change to workspace items, as pure functions: a snapshot and a context in, the changed collections out.
 * Groundwork's local MCP server and the hosted app both run these, so the rules (defaults, cascades, verdicts,
 * status changes, activity entries) live in one place.
 */

export interface Ctx {
  /** User id of the person acting. */
  actor: string;
  /** One timestamp for the whole change. */
  now: string;
  newId: () => string;
  /** Set when an agent made the change: the name of the token it used, e.g. "Claude Code". */
  via?: string;
}

export interface Change<R = void> {
  next: Partial<Collections>;
  result: R;
}

const nothing = <R>(result: R): Change<R> => ({ next: {}, result });

function log(c: Ctx, kind: Activity["kind"], text: string, refId?: string): Activity {
  return { id: c.newId(), at: c.now, actor: c.actor, text, kind, refId, ...(c.via ? { via: c.via } : {}) };
}

/** The most common area among linked items, so new items inherit one from their evidence. */
export function dominantArea(items: { productArea?: ProductArea }[]): ProductArea | undefined {
  const counts = new Map<ProductArea, number>();
  items.forEach((x) => x.productArea && counts.set(x.productArea, (counts.get(x.productArea) ?? 0) + 1));
  let best: ProductArea | undefined;
  let n = 0;
  counts.forEach((c, a) => {
    if (c > n) [best, n] = [a, c];
  });
  return best;
}

// ---------------------------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------------------------

export type NewInsight = Omit<Insight, "id" | "createdAt" | "createdBy">;

export function addInsights(s: Collections, c: Ctx, items: NewInsight[]): Change<Insight[]> {
  const created = items.map((i) => ({ ...i, id: c.newId(), createdAt: c.now, createdBy: c.actor }));
  return {
    next: {
      insights: [...created, ...s.insights],
      activity: [
        log(c, "insight", created.length === 1 ? `added insight "${created[0].title}"` : `added ${created.length} insights`, created[0]?.id),
        ...s.activity,
      ],
    },
    result: created,
  };
}

export function updateInsight(s: Collections, id: string, patch: Partial<Insight>): Change {
  return nothing0({ insights: s.insights.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
}

export function deleteInsight(s: Collections, id: string): Change {
  return nothing0({
    insights: s.insights.filter((i) => i.id !== id),
    hypotheses: s.hypotheses.map((h) => ({ ...h, insightIds: h.insightIds.filter((x) => x !== id) })),
    findings: s.findings.map((f) => ({ ...f, insightIds: f.insightIds.filter((x) => x !== id) })),
    requirements: s.requirements.map((r) => (r.insightIds ? { ...r, insightIds: r.insightIds.filter((x) => x !== id) } : r)),
  });
}

function nothing0(next: Partial<Collections>): Change {
  return { next, result: undefined };
}

// ---------------------------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------------------------

export type NewHypothesis = Omit<Hypothesis, "id" | "createdAt" | "updatedAt" | "owner">;

export function addHypotheses(s: Collections, c: Ctx, items: NewHypothesis[]): Change<Hypothesis[]> {
  const created = items.map((h) => ({
    ...h,
    productArea: h.productArea ?? dominantArea(s.insights.filter((i) => h.insightIds.includes(i.id))),
    id: c.newId(),
    owner: c.actor,
    createdAt: c.now,
    updatedAt: c.now,
  }));
  return {
    next: {
      hypotheses: [...created, ...s.hypotheses],
      activity: [
        log(c, "hypothesis", created.length === 1 ? `drafted "${created[0].title}"` : `drafted ${created.length} hypotheses`, created[0]?.id),
        ...s.activity,
      ],
    },
    result: created,
  };
}

export function updateHypothesis(s: Collections, c: Ctx, id: string, patch: Partial<Hypothesis>): Change {
  return nothing0({ hypotheses: s.hypotheses.map((h) => (h.id === id ? { ...h, ...patch, updatedAt: c.now } : h)) });
}

export function prioritizeMany(s: Collections, c: Ctx, ratings: { id: string; priority: Prioritization }[]): Change {
  if (!ratings.length) return nothing(undefined);
  const byId = new Map(ratings.map((r) => [r.id, r.priority]));
  return nothing0({
    hypotheses: s.hypotheses.map((h) => (byId.has(h.id) ? { ...h, priority: byId.get(h.id), updatedAt: c.now } : h)),
    activity: [
      log(c, "hypothesis", `prioritized ${ratings.length} hypothes${ratings.length === 1 ? "is" : "es"} in a round`, ratings[0].id),
      ...s.activity,
    ],
  });
}

/** Deleting a hypothesis deletes its experiments too. */
export function deleteHypothesis(s: Collections, id: string): Change {
  return nothing0({
    hypotheses: s.hypotheses.filter((h) => h.id !== id),
    experiments: s.experiments.filter((e) => e.hypothesisId !== id),
    requirements: s.requirements.map((r) => (r.hypothesisIds ? { ...r, hypothesisIds: r.hypothesisIds.filter((x) => x !== id) } : r)),
  });
}

// ---------------------------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------------------------

export type NewExperiment = Omit<Experiment, "id" | "owner">;

export function addExperiment(s: Collections, c: Ctx, item: NewExperiment): Change<Experiment> {
  const exp: Experiment = { ...item, id: c.newId(), owner: c.actor };
  return {
    next: { experiments: [exp, ...s.experiments], activity: [log(c, "experiment", `designed experiment "${exp.title}"`, exp.id), ...s.activity] },
    result: exp,
  };
}

export function updateExperiment(s: Collections, id: string, patch: Partial<Experiment>): Change {
  return nothing0({ experiments: s.experiments.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
}

/** Starting an experiment moves a draft hypothesis to "testing". */
export function startExperiment(s: Collections, c: Ctx, id: string): Change {
  const exp = s.experiments.find((e) => e.id === id);
  if (!exp) return nothing(undefined);
  return nothing0({
    experiments: s.experiments.map((e) => (e.id === id ? { ...e, status: "running", startDate: c.now } : e)),
    hypotheses: s.hypotheses.map((h) => (h.id === exp.hypothesisId && h.status === "draft" ? { ...h, status: "testing", updatedAt: c.now } : h)),
    activity: [log(c, "experiment", `started experiment "${exp.title}"`, id), ...s.activity],
  });
}

export interface RecordedResult {
  result: VerdictResult;
  prevConfidence: number;
}

/** Record results, compute the verdict and move the hypothesis to validated or invalidated. */
export function recordResults(
  s: Collections,
  c: Ctx,
  id: string,
  primaryActual: number,
  guardrailActuals: number[],
  notes: string,
): Change<RecordedResult | undefined> {
  const exp = s.experiments.find((e) => e.id === id);
  if (!exp) return nothing(undefined);
  const withActuals: Experiment = {
    ...exp,
    primaryMetric: { ...exp.primaryMetric, actual: primaryActual },
    guardrails: exp.guardrails.map((g, i): Metric => ({ ...g, actual: guardrailActuals[i] })),
  };
  const result = computeVerdict(withActuals);
  const updated: Experiment = { ...withActuals, status: "completed", endDate: c.now, resultNotes: notes, verdict: result.verdict };
  const hyp = s.hypotheses.find((h) => h.id === exp.hypothesisId);
  const newStatus = result.verdict === "validated" ? "validated" : result.verdict === "invalidated" ? "invalidated" : hyp?.status ?? "testing";
  const newConfidence = result.verdict === "validated" ? 86 : result.verdict === "invalidated" ? 14 : hyp?.confidence ?? 50;
  return {
    next: {
      experiments: s.experiments.map((e) => (e.id === id ? updated : e)),
      hypotheses: s.hypotheses.map((h) => (h.id === exp.hypothesisId ? { ...h, status: newStatus, confidence: newConfidence, updatedAt: c.now } : h)),
      activity: [log(c, "hypothesis", `${result.verdict} "${hyp?.title ?? "hypothesis"}" via experiment results`, exp.hypothesisId), ...s.activity],
    },
    result: { result, prevConfidence: hyp?.confidence ?? 50 },
  };
}

export function deleteExperiment(s: Collections, id: string): Change {
  return nothing0({
    experiments: s.experiments.filter((e) => e.id !== id),
    findings: s.findings.map((f) => (f.experimentIds.includes(id) ? { ...f, experimentIds: f.experimentIds.filter((x) => x !== id) } : f)),
  });
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

export type NewFinding = Omit<Finding, "id" | "createdAt">;

export function addFindings(s: Collections, c: Ctx, items: NewFinding[]): Change<Finding[]> {
  const created = items.map((f) => ({
    ...f,
    productArea:
      f.productArea ??
      dominantArea(s.hypotheses.filter((h) => f.hypothesisIds.includes(h.id))) ??
      dominantArea(s.insights.filter((i) => f.insightIds.includes(i.id))),
    id: c.newId(),
    createdAt: c.now,
  }));
  return {
    next: {
      findings: [...created, ...s.findings],
      activity: [
        log(c, "finding", created.length === 1 ? `synthesized finding "${created[0].title}"` : `synthesized ${created.length} findings`, created[0]?.id),
        ...s.activity,
      ],
    },
    result: created,
  };
}

export function updateFinding(s: Collections, id: string, patch: Partial<Finding>): Change {
  return nothing0({ findings: s.findings.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
}

export function deleteFinding(s: Collections, id: string): Change {
  return nothing0({
    findings: s.findings.filter((f) => f.id !== id),
    requirements: s.requirements.map((r) => ({ ...r, findingIds: r.findingIds.filter((x) => x !== id) })),
  });
}

// ---------------------------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------------------------

export type DerivedRequirement = Omit<Requirement, "id" | "createdAt" | "status">;
export type DirectRequirement = Omit<Requirement, "id" | "createdAt" | "findingIds">;

/** Requirements derived from findings. They start as drafts. */
export function addRequirements(s: Collections, c: Ctx, items: DerivedRequirement[]): Change<Requirement[]> {
  const created = items.map((r) => ({
    ...r,
    productArea: r.productArea ?? dominantArea(s.findings.filter((f) => r.findingIds.includes(f.id))),
    id: c.newId(),
    createdAt: c.now,
    status: "draft" as const,
  }));
  return {
    next: {
      requirements: [...created, ...s.requirements],
      activity: [
        log(
          c,
          "requirement",
          created.length === 1 ? `derived requirement "${created[0].title}"` : `derived ${created.length} requirements`,
          created[0]?.id,
        ),
        ...s.activity,
      ],
    },
    result: created,
  };
}

/** A requirement created directly, bypassing hypotheses and experiments: the decision is already made. */
export function createRequirement(s: Collections, c: Ctx, item: DirectRequirement): Change<Requirement> {
  const r: Requirement = {
    kind: "solution",
    ...item,
    findingIds: [],
    productArea: item.productArea ?? dominantArea(s.insights.filter((i) => item.insightIds?.includes(i.id))),
    id: c.newId(),
    createdAt: c.now,
  };
  return {
    next: { requirements: [r, ...s.requirements], activity: [log(c, "requirement", `created requirement "${r.title}" directly`, r.id), ...s.activity] },
    result: r,
  };
}

export function updateRequirement(s: Collections, id: string, patch: Partial<Requirement>): Change {
  return nothing0({ requirements: s.requirements.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
}

export function deleteRequirement(s: Collections, id: string): Change {
  return nothing0({
    requirements: s.requirements
      .filter((r) => r.id !== id)
      .map((r) => {
        if (![r.stakeholderIds, r.replaces, r.obsoletedBy].some((l) => l?.includes(id))) return r;
        const x = { ...r };
        if (r.stakeholderIds?.includes(id)) x.stakeholderIds = r.stakeholderIds.filter((v) => v !== id);
        if (r.replaces?.includes(id)) x.replaces = r.replaces.filter((v) => v !== id);
        if (r.obsoletedBy?.includes(id)) {
          x.obsoletedBy = r.obsoletedBy.filter((v) => v !== id);
          // Its only replacement is gone: it isn't going to become obsolete after all.
          if (!x.obsoletedBy.length && r.obsoletePlannedFor && r.status !== "obsolete") delete x.obsoletePlannedFor;
        }
        return x;
      }),
  });
}

/** Ask someone to sign off a draft. */
export function submitRequirement(s: Collections, c: Ctx, id: string, approver: string): Change<boolean> {
  const r = s.requirements.find((x) => x.id === id);
  if (!r || r.status !== "draft") return nothing(false);
  return {
    next: {
      requirements: s.requirements.map((x) => (x.id === id ? { ...x, status: "awaiting-approval", approver } : x)),
      activity: [log(c, "requirement", `asked for approval of "${r.title}"`, id), ...s.activity],
    },
    result: true,
  };
}

/** Approve a requirement. `by` records an approval someone else gave outside Groundwork, e.g. verbally. */
export function approveRequirement(s: Collections, c: Ctx, id: string, by?: { approvedBy: string; note?: string }): Change<boolean> {
  const r = s.requirements.find((x) => x.id === id);
  if (!r || r.status === "approved" || r.status === "in-delivery" || r.status === "obsolete") return nothing(false);
  const approvedBy = by?.approvedBy ?? c.actor;
  const onBehalf = approvedBy !== c.actor;
  const approved: Requirement = {
    ...r,
    status: "approved",
    approvedBy,
    approvedAt: c.now,
    approver: r.approver ?? approvedBy,
    ...(onBehalf ? { recordedBy: c.actor } : {}),
    ...(by?.note ? { approvalNote: by.note } : {}),
  };
  return {
    next: {
      requirements: s.requirements.map((x) => (x.id === id ? approved : x)),
      activity: [log(c, "requirement", onBehalf ? `approved "${r.title}" for ${approvedBy}` : `approved "${r.title}"`, id), ...s.activity],
    },
    result: true,
  };
}

export function sendBackRequirement(s: Collections, c: Ctx, id: string): Change<boolean> {
  const r = s.requirements.find((x) => x.id === id);
  if (!r || r.status !== "awaiting-approval") return nothing(false);
  return {
    next: {
      requirements: s.requirements.map((x) => (x.id === id ? { ...x, status: "draft" } : x)),
      activity: [log(c, "requirement", `sent "${r.title}" back for changes`, id), ...s.activity],
    },
    result: true,
  };
}

export function obsoleteRequirement(s: Collections, c: Ctx, id: string, by?: string[]): Change<boolean> {
  const r = s.requirements.find((x) => x.id === id);
  if (!r || !canObsolete(r)) return nothing(false);
  return {
    next: {
      requirements: s.requirements.map((x) =>
        x.id === id ? { ...x, status: "obsolete", obsoletedAt: c.now, obsoletedBy: by?.length ? by : x.obsoletedBy } : x,
      ),
      activity: [log(c, "requirement", `made "${r.title}" obsolete`, id), ...s.activity],
    },
    result: true,
  };
}

/** Save the outcome of deriving requirements: new ones, updated drafts, and approved ones made obsolete. */
export function applyRequirementChanges(s: Collections, c: Ctx, { create, update, obsolete }: RequirementChanges): Change {
  const before = s.requirements;
  const patches = new Map<string, Partial<Requirement>>();
  update.forEach((u) => patches.set(u.id, { ...patches.get(u.id), ...u.patch }));
  const supersede = new Map<string, string[]>();
  obsolete.forEach((o) => {
    const r = before.find((x) => x.id === o.id);
    if (r && canObsolete(r)) supersede.set(o.id, [...(supersede.get(o.id) ?? []), o.by]);
  });
  const updatedDrafts = update.filter((u) => u.patch.title).map((u) => u.id);
  const stake = create.filter((r) => kindOf(r) === "stakeholder").length;
  const sol = create.length - stake;
  const parts = [stake && `${stake} stakeholder`, sol && `${sol} solution`].filter(Boolean);
  const entries: Activity[] = [];
  if (create.length) entries.push(log(c, "requirement", `derived ${parts.join(" and ")} requirement${create.length === 1 ? "" : "s"}`, create[0].id));
  updatedDrafts.forEach((id) => entries.push(log(c, "requirement", `updated draft "${patches.get(id)?.title}" from a new finding`, id)));
  supersede.forEach((_, id) => entries.push(log(c, "requirement", `made "${before.find((x) => x.id === id)?.title}" obsolete`, id)));
  return nothing0({
    requirements: [
      ...create,
      ...s.requirements.map((r) => {
        let x = patches.has(r.id) ? { ...r, ...patches.get(r.id) } : r;
        if (supersede.has(r.id)) x = { ...x, status: "obsolete", obsoletedAt: c.now, obsoletedBy: supersede.get(r.id) };
        return x;
      }),
    ],
    activity: [...entries.reverse(), ...s.activity],
  });
}

/** Record the Linear issue an approved requirement became, and move it to "in delivery". */
export function markSentToDelivery(s: Collections, c: Ctx, id: string, delivery: Delivery): Change<boolean> {
  const r = s.requirements.find((x) => x.id === id);
  if (!r || r.delivery) return nothing(false);
  return {
    next: {
      requirements: s.requirements.map((x) => (x.id === id ? { ...x, status: "in-delivery", delivery } : x)),
      activity: [log(c, "requirement", `sent "${r.title}" to Linear as ${delivery.identifier}`, id), ...s.activity],
    },
    result: true,
  };
}

export function updateDeliveryStates(s: Collections, byRequirement: Record<string, Delivery>): Change {
  return nothing0({ requirements: s.requirements.map((r) => (byRequirement[r.id] ? { ...r, delivery: byRequirement[r.id] } : r)) });
}

/**
 * Plan requirements for a product version. Requirements they replace, whose obsolescence was planned with them,
 * move to the same version: an old requirement stays valid until its replacement ships.
 */
export function planRequirements(s: Collections, c: Ctx, ids: string[], version: string): Change<boolean> {
  const planned = s.requirements.filter((r) => ids.includes(r.id));
  if (!planned.length) return nothing(false);
  const replaced = new Set(planned.flatMap((r) => r.replaces ?? []));
  return {
    next: {
      requirements: s.requirements.map((r) =>
        ids.includes(r.id)
          ? { ...r, plannedFor: version }
          : replaced.has(r.id) && r.obsoletePlannedFor && !r.obsoletedIn && r.obsoletedBy?.some((x) => ids.includes(x))
            ? { ...r, obsoletePlannedFor: version }
            : r,
      ),
      activity: [...planned.map((r) => log(c, "requirement", `planned "${r.title}" for ${version}`, r.id)), ...s.activity],
    },
    result: true,
  };
}

/**
 * Plan requirements to become obsolete in a version, e.g. the one their replacement ships in. They stay approved
 * (and valid) until that version is released.
 */
export function planObsolescence(s: Collections, c: Ctx, ids: string[], version: string, by?: string[]): Change<boolean> {
  const hit = s.requirements.filter((r) => ids.includes(r.id));
  if (!hit.length) return nothing(false);
  return {
    next: {
      requirements: s.requirements.map((r) => (ids.includes(r.id) ? { ...r, obsoletePlannedFor: version, ...(by?.length ? { obsoletedBy: by } : {}) } : r)),
      activity: [...hit.map((r) => log(c, "requirement", `"${r.title}" will be obsolete in ${version}`, r.id)), ...s.activity],
    },
    result: true,
  };
}
