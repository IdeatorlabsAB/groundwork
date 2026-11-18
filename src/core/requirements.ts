import type { ID, Requirement, RequirementKind } from "./types";

/** Requirements saved before the stakeholder / solution split are solution requirements. */
export function kindOf(r: Pick<Requirement, "kind">): RequirementKind {
  return r.kind ?? "solution";
}

export const isObsolete = (r: Pick<Requirement, "status">) => r.status === "obsolete";

/** Only approved requirements can be made obsolete. Drafts are updated in place instead. */
export const canObsolete = (r: Pick<Requirement, "status">) => r.status === "approved";
export const canUpdateInPlace = (r: Pick<Requirement, "status">) => r.status === "draft";

/** Only approved solution requirements go to a delivery tool, and only once. */
export const canSendToDelivery = (r: Pick<Requirement, "kind" | "status" | "delivery">) =>
  kindOf(r) === "solution" && r.status === "approved" && !r.delivery;

/** New requirements, rewritten drafts and approved requirements made obsolete, decided together. */
export interface RequirementChanges {
  create: Requirement[];
  update: { id: ID; patch: Partial<Requirement> }[];
  obsolete: { id: ID; by: ID }[];
}
