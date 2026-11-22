export type ID = string;

export type SourceType =
  | "interview"
  | "support"
  | "survey"
  | "analytics"
  | "observation";

export type Sentiment = "negative" | "neutral" | "positive";

/** The id of a product area defined by the workspace. Experiments take theirs from their hypothesis. */
export type ProductArea = string;

export interface Insight {
  id: ID;
  title: string;
  quote: string;
  source: SourceType;
  persona: string;
  participant?: string;
  tags: string[];
  sentiment: Sentiment;
  productArea?: ProductArea;
  createdAt: string;
  createdBy: string;
}

export type HypothesisStatus = "draft" | "testing" | "validated" | "invalidated";

/** A 1–5 rating. 3 or more counts as high learning / easy to reverse. */
export type Score = 1 | 2 | 3 | 4 | 5;

/**
 * Where a hypothesis sits on Learning value × Reversibility, rated by the PM or the team.
 * Source: Jeff Gothelf, "How to prioritize your backlog when effort is no longer the constraint".
 */
export interface Prioritization {
  learning: Score;
  reversibility: Score;
  /** Why the learning score: what building it would teach us */
  teaches: string;
  /** Why the reversibility score: what undoing it would take */
  toUndo: string;
  ratedAt: string;
  /** "coach" = rated while writing the hypothesis; "round" = rated in a prioritization round. */
  ratedIn: "coach" | "round";
}

/** The PM's own definition of success: one number, a baseline, a bar and a timeframe. */
export interface SuccessMetric {
  name: string;
  unit: string;
  baseline: number;
  target: number;
  direction: "decrease" | "increase";
  /** e.g. "over a 4-week pilot" */
  timeframe: string;
}

export interface Hypothesis {
  id: ID;
  title: string;
  /** "We believe we will [achieve] [outcome]": the business result the team is after. */
  outcome: string;
  /** "…if [forWhom]": the users. */
  forWhom: string;
  /** "…[get] [benefit]": what the users gain, in their terms. */
  benefit: string;
  /** "…with [feature]": the product idea, written by the PM. */
  feature: string;
  /** Plain-language success statement. Composed from successMetric + guardrail when those are set. */
  knowWhen: string;
  /** What target users rely on today: competitors, workarounds, or doing nothing. */
  alternatives?: string;
  /** Why this solution wins against those alternatives. */
  edge?: string;
  successMetric?: SuccessMetric;
  /** What must not get worse while chasing the success metric. */
  guardrail?: string;
  /** What must be true for this to work; the thing most likely to kill it. */
  riskiestAssumption?: string;
  /** Learning value × reversibility rating. Unset until the PM prioritizes it. */
  priority?: Prioritization;
  status: HypothesisStatus;
  productArea?: ProductArea;
  confidence: number; // 0-100
  insightIds: ID[];
  owner: string;
  createdAt: string;
  updatedAt: string;
  aiGenerated?: boolean;
}

export type ExperimentMethod =
  | "pilot"
  | "ab-test"
  | "prototype-test"
  | "survey"
  | "fake-door"
  | "concierge";

export type ExperimentStatus = "planned" | "running" | "completed";

export interface Metric {
  name: string;
  unit: string;
  baseline: number;
  /** For "decrease" metrics success means actual <= target; for "increase", actual >= target. */
  target: number;
  direction: "decrease" | "increase";
  actual?: number;
}

export type Verdict = "validated" | "invalidated" | "inconclusive";

export interface Experiment {
  id: ID;
  hypothesisId: ID;
  title: string;
  method: ExperimentMethod;
  description: string;
  primaryMetric: Metric;
  guardrails: Metric[];
  sampleSize: string;
  durationWeeks: number;
  status: ExperimentStatus;
  startDate?: string;
  endDate?: string;
  resultNotes?: string;
  /** For small bets: the date to check whether it made a meaningful difference (YYYY-MM-DD). */
  checkBackDate?: string;
  verdict?: Verdict;
  owner: string;
  aiGenerated?: boolean;
}

export interface Finding {
  id: ID;
  title: string;
  summary: string;
  experimentIds: ID[];
  hypothesisIds: ID[];
  insightIds: ID[];
  confidence: "low" | "medium" | "high";
  productArea?: ProductArea;
  createdAt: string;
  aiGenerated?: boolean;
}

export type Priority = "must" | "should" | "could";

/**
 * "draft" can still be edited in place. Only an "approved" requirement can be made "obsolete",
 * e.g. when newer evidence supersedes it.
 */
export type RequirementStatus = "draft" | "awaiting-approval" | "approved" | "in-delivery" | "obsolete";

/**
 * Stakeholder requirements state who needs what and why, as a user story
 * ("As a <role> I want <need> so that <reason>").
 * Solution requirements state the qualities and behaviour the solution must have to meet one or
 * more stakeholder requirements, as "shall" statements. Every solution requirement fulfils at
 * least one stakeholder requirement.
 */
export type RequirementKind = "stakeholder" | "solution";

/**
 * Why a requirement was created directly, without hypotheses or experiments: the decision to
 * build it was already made elsewhere. Unset for requirements derived from findings.
 */
export type RequirementOrigin = "tender" | "regulation" | "contract" | "customer-need";

/** Linear's workflow state categories. */
export type DeliveryStateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

/** The issue a requirement became in the team's delivery tool. */
export interface Delivery {
  tracker: "linear";
  issueId: string;
  /** e.g. "MER-142" */
  identifier: string;
  url?: string;
  /** Linear's status for the issue, as of `syncedAt`. */
  state: { name: string; type: DeliveryStateType };
  sentAt: string;
  syncedAt: string;
}

/** The Linear team approved requirements are sent to. Unset until a workspace owner connects Linear. */
export interface DeliverySettings {
  teamId?: string;
  teamKey?: string;
  teamName?: string;
}

export interface Requirement {
  id: ID;
  /** Unset on requirements saved before the split; treat as "solution". */
  kind?: RequirementKind;
  title: string;
  /** Stakeholder requirements: the user story. Solution requirements: the "shall" statements. */
  story: string;
  /** Stakeholder requirements: who has the need, e.g. "Finance managers". */
  stakeholder?: string;
  /** Solution requirements: the product that delivers it, e.g. "Acme mobile app". */
  product?: string;
  /** Solution requirements: the stakeholder requirements this one fulfils (at least one). */
  stakeholderIds?: ID[];
  acceptanceCriteria: string[];
  priority: Priority;
  status: RequirementStatus;
  productArea?: ProductArea;
  /** Who needs to sign this off while it is awaiting approval. */
  approver?: string;
  approvedBy?: string;
  approvedAt?: string;
  /** Set when someone recorded an approval given by another person, e.g. verbally: who entered it. */
  recordedBy?: string;
  /** How or where it was approved, e.g. "Approved by Maria in sprint planning". */
  approvalNote?: string;
  findingIds: ID[];
  /** Set when the requirement was created directly: decided, not validated by an experiment. */
  origin?: RequirementOrigin;
  /** Where the decision comes from, e.g. "Region North tender 2026, section 4.2". */
  originNote?: string;
  /** Customer evidence linked directly, not through findings. */
  insightIds?: ID[];
  /** Hypotheses this was committed from, e.g. one that landed in "Stay out of this box". */
  hypothesisIds?: ID[];
  /** Set when the requirement was made obsolete: the requirements that replaced it. */
  obsoletedBy?: ID[];
  obsoletedAt?: string;
  /** The approved requirements this one replaces. They become obsolete when this one ships (or on approval, without versions). */
  replaces?: ID[];
  /** Solution requirements: the planned version of its product it's meant to ship in. Set on approval. */
  plannedFor?: string;
  /** Solution requirements: the version it shipped in. Set by the release step. */
  releasedIn?: string;
  releasedAt?: string;
  releasedBy?: string;
  /** The planned version that will make it obsolete, e.g. the one its replacement ships in. It stays valid until then. */
  obsoletePlannedFor?: string;
  /** The version that made it obsolete. Set by the release step. */
  obsoletedIn?: string;
  createdAt: string;
  /** Last time an existing requirement was rewritten, e.g. a draft updated from a new finding. */
  updatedAt?: string;
  aiGenerated?: boolean;
  /** Set once the requirement was sent to Linear. */
  delivery?: Delivery;
}

export interface Activity {
  id: ID;
  at: string;
  actor: string;
  text: string;
  kind: "insight" | "hypothesis" | "experiment" | "finding" | "requirement";
  refId?: ID;
  /** Set when a coding agent made the change: the name of the token it used, e.g. "Claude Code". */
  via?: string;
}
