import { canObsolete, kindOf, sameTicket, ticketsOf, type RequirementChanges } from "./requirements";
import { caseKey, sameCodeTest, takesTests } from "./test-links";
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
  Risk,
  CodeTestLink,
  TestCaseLink,
  Ticket,
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
    risks: s.risks.map((r) => (r.mitigationIds.includes(id) ? { ...r, mitigationIds: without(r.mitigationIds, id) } : r)),
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

/**
 * A requirement's own tickets, plus the web app's Linear issue (`delivery`) when `t` is that issue: then it becomes
 * a real ticket entry, keeping its original link time, so it can be refreshed and its release record doesn't change.
 */
function ticketList(r: Requirement, t: Pick<Ticket, "tracker" | "key">): Ticket[] {
  const own = Array.isArray(r.tickets) ? r.tickets : [];
  if (r.delivery && !own.some((x) => sameTicket(x, t)) && sameTicket({ tracker: "linear", key: r.delivery.identifier }, t)) return ticketsOf(r);
  return own;
}

/** Link a ticket to requirements. Already linked: its details are refreshed from what's given. */
export function linkTickets(s: Collections, c: Ctx, ids: string[], ticket: Omit<Ticket, "linkedAt" | "linkedBy">): Change<boolean> {
  const t = { ...ticket, tracker: ticket.tracker.toLowerCase() };
  const details = Object.fromEntries(Object.entries({ url: t.url, title: t.title, state: t.state, done: t.done }).filter(([, v]) => v !== undefined));
  return {
    next: {
      requirements: s.requirements.map((r) => {
        if (!ids.includes(r.id)) return r;
        const list = ticketList(r, t);
        return list.some((x) => sameTicket(x, t))
          ? { ...r, tickets: list.map((x) => (sameTicket(x, t) ? { ...x, ...details } : x)) }
          : { ...r, tickets: [...list, { ...t, linkedAt: c.now, linkedBy: c.actor }] };
      }),
      activity: [log(c, "requirement", `linked ${t.tracker} ${t.key}`, ids[0]), ...s.activity],
    },
    result: true,
  };
}

export function unlinkTickets(s: Collections, c: Ctx, ids: string[], ticket: Pick<Ticket, "tracker" | "key">): Change<boolean> {
  return {
    next: {
      requirements: s.requirements.map((r) => (ids.includes(r.id) && r.tickets?.some((x) => sameTicket(x, ticket)) ? { ...r, tickets: r.tickets.filter((x) => !sameTicket(x, ticket)) } : r)),
      activity: [log(c, "requirement", `unlinked ${ticket.tracker} ${ticket.key}`, ids[0]), ...s.activity],
    },
    result: true,
  };
}

/** Refresh ticket states from the tracker, on every requirement that has the ticket. */
export function updateTickets(
  s: Collections,
  c: Ctx,
  updates: { tracker: string; key: string; state?: string; done?: boolean; title?: string }[],
): Change<{ updated: number; notLinked: { tracker: string; key: string }[] }> {
  let updated = 0;
  const notLinked: { tracker: string; key: string }[] = [];
  let requirements = s.requirements;
  for (const u of updates) {
    let hit = false;
    const patch = Object.fromEntries(Object.entries({ state: u.state, done: u.done, title: u.title }).filter(([, v]) => v !== undefined));
    requirements = requirements.map((r) => {
      const list = ticketList(r, u);
      if (!list.some((x) => sameTicket(x, u))) return r;
      hit = true;
      updated++;
      return { ...r, tickets: list.map((x) => (sameTicket(x, u) ? { ...x, ...patch, syncedAt: c.now } : x)) };
    });
    if (!hit) notLinked.push({ tracker: u.tracker.toLowerCase(), key: u.key });
  }
  return { next: { requirements }, result: { updated, notLinked } };
}

// ---------------------------------------------------------------------------------------------
// Risks (ported from centropic-prototype src/lib/domain/ops.ts; keep in step)
// ---------------------------------------------------------------------------------------------

export type NewRisk = Omit<Risk, "id" | "createdAt" | "updatedAt">;

export function addRisks(s: Collections, c: Ctx, items: NewRisk[]): Change<Risk[]> {
  const created: Risk[] = items.map((r) => ({ ...r, id: c.newId(), createdAt: c.now }));
  const text = created.length === 1 ? "added 1 risk" : `added ${created.length} risks`;
  return { next: { risks: [...created, ...s.risks], activity: [log(c, "risk", text, created[0]?.id), ...s.activity] }, result: created };
}

export function updateRisk(s: Collections, c: Ctx, id: string, patch: Partial<Risk>): Change {
  return nothing0({ risks: s.risks.map((r) => (r.id === id ? { ...r, ...patch, updatedAt: c.now } : r)) });
}

export function deleteRisk(s: Collections, id: string): Change {
  return nothing0({
    risks: s.risks.filter((r) => r.id !== id),
    requirements: s.requirements.map((r) => (r.riskIds?.includes(id) ? { ...r, riskIds: without(r.riskIds, id) } : r)),
  });
}

function without(ids: string[] | undefined, id: string) {
  return (ids ?? []).filter((x) => x !== id);
}
function withId(ids: string[] | undefined, id: string) {
  return ids?.includes(id) ? ids : [...(ids ?? []), id];
}

/** Record a requirement as a control for a risk, on both sides. */
export function linkMitigation(s: Collections, c: Ctx, riskId: string, requirementId: string): Change<boolean> {
  const risk = s.risks.find((r) => r.id === riskId);
  const req = s.requirements.find((r) => r.id === requirementId);
  if (!risk || !req) return nothing(false);
  if (risk.mitigationIds.includes(requirementId) && req.riskIds?.includes(riskId)) return nothing(true);
  return {
    next: {
      risks: s.risks.map((r) => (r === risk ? { ...r, mitigationIds: withId(r.mitigationIds, requirementId), updatedAt: c.now } : r)),
      requirements: s.requirements.map((r) => (r === req ? { ...r, riskIds: withId(r.riskIds, riskId) } : r)),
      activity: [log(c, "risk", `linked requirement "${req.title}" as mitigation for risk "${risk.title}"`, risk.id), ...s.activity],
    },
    result: true,
  };
}

export function unlinkMitigation(s: Collections, c: Ctx, riskId: string, requirementId: string): Change<boolean> {
  const risk = s.risks.find((r) => r.id === riskId);
  const req = s.requirements.find((r) => r.id === requirementId);
  if (!risk || !req) return nothing(false);
  return {
    next: {
      risks: s.risks.map((r) => (r === risk ? { ...r, mitigationIds: without(r.mitigationIds, requirementId), updatedAt: c.now } : r)),
      requirements: s.requirements.map((r) => (r === req ? { ...r, riskIds: without(r.riskIds, riskId) } : r)),
      activity: [log(c, "risk", `removed requirement "${req.title}" as mitigation for risk "${risk.title}"`, risk.id), ...s.activity],
    },
    result: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Tests (code tests ported from centropic-prototype src/lib/domain/ops.ts; test cases tool-neutral)
// ---------------------------------------------------------------------------------------------

/** Link automated tests in the repository to a solution requirement. Tests already linked are skipped. */
export function linkCodeTests(s: Collections, c: Ctx, requirementId: string, tests: Pick<CodeTestLink, "path" | "name">[]): Change<number> {
  const req = s.requirements.find((r) => r.id === requirementId);
  if (!req || !takesTests(req)) return nothing(0);
  const list = req.codeTests ?? [];
  const added = tests.filter((t, i) => !list.some((x) => sameCodeTest(x, t)) && tests.findIndex((y) => sameCodeTest(y, t)) === i);
  if (!added.length) return nothing(0);
  return {
    next: {
      requirements: s.requirements.map((r) =>
        r === req ? { ...r, codeTests: [...list, ...added.map((t) => ({ path: t.path, name: t.name, linkedAt: c.now, linkedBy: c.actor }))], updatedAt: c.now } : r,
      ),
      activity: [log(c, "requirement", `linked ${added.length === 1 ? "a code test" : `${added.length} code tests`} to "${req.title}"`, req.id), ...s.activity],
    },
    result: added.length,
  };
}

export function unlinkCodeTests(s: Collections, c: Ctx, requirementId: string, tests: Pick<CodeTestLink, "path" | "name">[]): Change<number> {
  const req = s.requirements.find((r) => r.id === requirementId);
  const list = req?.codeTests ?? [];
  const kept = list.filter((x) => !tests.some((t) => sameCodeTest(x, t)));
  if (!req || kept.length === list.length) return nothing(0);
  return {
    next: {
      requirements: s.requirements.map((r) => (r === req ? { ...r, codeTests: kept.length ? kept : undefined, updatedAt: c.now } : r)),
      activity: [log(c, "requirement", `unlinked ${list.length - kept.length === 1 ? "a code test" : `${list.length - kept.length} code tests`} from "${req.title}"`, req.id), ...s.activity],
    },
    result: list.length - kept.length,
  };
}

/**
 * Link cases from any test-management tool to a solution requirement. A case already linked keeps when and by whom
 * it was linked, and takes the new title and url. Returns how many were new.
 */
export function linkTestCases(s: Collections, c: Ctx, requirementId: string, cases: Omit<TestCaseLink, "linkedAt" | "linkedBy">[]): Change<number> {
  const req = s.requirements.find((r) => r.id === requirementId);
  if (!req || !takesTests(req) || !cases.length) return nothing(0);
  const byKey = new Map((req.testCases ?? []).map((t) => [caseKey(t), t]));
  let added = 0;
  for (const t of cases) {
    const was = byKey.get(caseKey(t));
    if (!was) added++;
    byKey.set(caseKey(t), {
      ...(was ?? {}),
      tool: was?.tool ?? t.tool.toLowerCase(),
      id: was?.id ?? t.id,
      ...(was?.project ?? t.project ? { project: was?.project ?? t.project } : {}),
      title: t.title,
      ...(t.url ? { url: t.url } : was?.url ? { url: was.url } : {}),
      linkedAt: was?.linkedAt ?? c.now,
      linkedBy: was?.linkedBy ?? c.actor,
    });
  }
  const n = cases.length;
  return {
    next: {
      requirements: s.requirements.map((r) => (r === req ? { ...r, testCases: [...byKey.values()], updatedAt: c.now } : r)),
      activity: [log(c, "requirement", `linked ${n === 1 ? "a test case" : `${n} test cases`} to "${req.title}"`, req.id), ...s.activity],
    },
    result: added,
  };
}

export function unlinkTestCases(s: Collections, c: Ctx, requirementId: string, cases: Pick<TestCaseLink, "tool" | "id" | "project">[]): Change<number> {
  const req = s.requirements.find((r) => r.id === requirementId);
  const list = req?.testCases ?? [];
  const drop = new Set(cases.map(caseKey));
  const kept = list.filter((x) => !drop.has(caseKey(x)));
  if (!req || kept.length === list.length) return nothing(0);
  const n = list.length - kept.length;
  return {
    next: {
      requirements: s.requirements.map((r) => (r === req ? { ...r, testCases: kept.length ? kept : undefined, updatedAt: c.now } : r)),
      activity: [log(c, "requirement", `unlinked ${n === 1 ? "a test case" : `${n} test cases`} from "${req.title}"`, req.id), ...s.activity],
    },
    result: n,
  };
}
