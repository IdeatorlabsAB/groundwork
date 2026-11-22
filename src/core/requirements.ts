import type { ID, Requirement, RequirementKind } from "./types";

/** Requirements saved before the stakeholder / solution split are solution requirements. */
export function kindOf(r: Pick<Requirement, "kind">): RequirementKind {
  return r.kind ?? "solution";
}

export const isObsolete = (r: Pick<Requirement, "status">) => r.status === "obsolete";
export const isActive = (r: Pick<Requirement, "status">) => !isObsolete(r);

/** Only approved requirements can be made obsolete. Drafts are updated in place instead. */
export const canObsolete = (r: Pick<Requirement, "status">) => r.status === "approved";
export const canUpdateInPlace = (r: Pick<Requirement, "status">) => r.status === "draft";
/** Approved (or in-delivery) requirements are replaced; drafts are updated in place instead. */
export const canBeReplaced = (r: Pick<Requirement, "status">) => r.status === "approved" || r.status === "in-delivery";

/** Only approved solution requirements go to a delivery tool, and only once. */
export const canSendToDelivery = (r: Pick<Requirement, "kind" | "status" | "delivery">) =>
  kindOf(r) === "solution" && r.status === "approved" && !r.delivery;

/** A stakeholder requirement is a user story: "As a <role> I want <need> so that <reason>". */
export const STAKEHOLDER_STORY = /^\s*as\s+an?\s+.+?\bI\s+(want|need)\b.+?\bso\s+that\b/is;
/** A solution requirement is one or more "shall" statements. */
export const SOLUTION_STATEMENT = /\bshall\b/i;

/** Advice when a requirement's story isn't written the way its layer expects. Never blocks a write. */
export function wordingWarnings(r: Pick<Requirement, "kind" | "story">): string[] {
  const story = r.story ?? "";
  if (kindOf(r) === "stakeholder") {
    return STAKEHOLDER_STORY.test(story)
      ? []
      : ['a stakeholder requirement should be a user story: "As a <role> I want <need> so that <reason>"'];
  }
  return SOLUTION_STATEMENT.test(story)
    ? []
    : ['a solution requirement should be written as "shall" statements, e.g. "The <system or part> shall …"'];
}

/** The active solution requirements that fulfil a stakeholder requirement. */
export function fulfilledBy(id: ID, requirements: Requirement[]): Requirement[] {
  return requirements.filter((r) => kindOf(r) === "solution" && isActive(r) && r.stakeholderIds?.includes(id));
}

/** Why this combination of kind and stakeholder links isn't allowed, if it isn't. */
export function layerProblem(r: Pick<Requirement, "kind" | "stakeholderIds">): string | undefined {
  if (kindOf(r) === "solution" && !r.stakeholderIds?.length) {
    return "a solution requirement must fulfil at least one stakeholder requirement: add stakeholderIds (add the stakeholder requirement first if it doesn't exist)";
  }
  if (kindOf(r) === "stakeholder" && r.stakeholderIds?.length) return "stakeholderIds is only for solution requirements";
  return undefined;
}

/** New requirements, rewritten drafts and approved requirements made obsolete, decided together. */
export interface RequirementChanges {
  create: Requirement[];
  update: { id: ID; patch: Partial<Requirement> }[];
  obsolete: { id: ID; by: ID }[];
}
