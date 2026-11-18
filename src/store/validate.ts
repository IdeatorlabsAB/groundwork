import { z } from "zod";
import type { Collections } from "../core/collections";
import { kindOf } from "../core/requirements";
import { EXPERIMENT_STATUS, HYPOTHESIS_STATUS, localSchemas, type Kind } from "../core/schemas";
import type { Requirement } from "../core/types";
import type { Config } from "./config";
import { COLLECTIONS, type Loaded } from "./files";

export interface Problem {
  level: "error" | "warning";
  file: string;
  message: string;
}

const REQUIREMENT_STATUS = z.enum(["draft", "awaiting-approval", "approved", "in-delivery", "obsolete"]);
const { insightInput, hypothesisInput, experimentInput, findingInput, requirementInput } = localSchemas;

/** What a stored item must look like: the agent's input shape plus the fields Groundwork sets. Unknown fields are kept. */
const STORED: Record<Kind, z.ZodType> = {
  insight: insightInput.extend({ createdAt: z.string() }).loose(),
  hypothesis: hypothesisInput.extend({ status: HYPOTHESIS_STATUS, knowWhen: z.string().optional() }).loose(),
  experiment: experimentInput.extend({ status: EXPERIMENT_STATUS }).loose(),
  finding: findingInput.loose(),
  requirement: requirementInput.extend({ status: REQUIREMENT_STATUS, acceptanceCriteria: z.array(z.string()).default([]) }).loose(),
};

/** Every problem in a project: unreadable files, invalid fields, broken or wrong-kind links, unknown areas. */
export function validate(loaded: Loaded, config: Config): Problem[] {
  const out: Problem[] = loaded.problems.map((p) => ({ level: "error", ...p }));
  const s: Collections = loaded.items;
  const kindById = new Map<string, Kind>();
  for (const kind of Object.keys(COLLECTIONS) as Kind[]) for (const x of s[COLLECTIONS[kind]] as { id: string }[]) kindById.set(x.id, kind);
  const areaIds = new Set(config.productAreas.map((a) => a.id));
  const people = new Set(config.people.map((p) => p.id));

  for (const kind of Object.keys(COLLECTIONS) as Kind[]) {
    for (const item of s[COLLECTIONS[kind]] as unknown as (Record<string, unknown> & { id: string })[]) {
      const file = loaded.paths.get(item.id) ?? item.id;
      const err = (message: string) => out.push({ level: "error", file, message });
      const warn = (message: string) => out.push({ level: "warning", file, message });

      const parsed = STORED[kind].safeParse(item);
      if (!parsed.success) err(z.prettifyError(parsed.error).replace(/\n/g, "; "));

      const link = (field: string, want: Kind, ids: unknown) => {
        for (const id of Array.isArray(ids) ? ids : ids === undefined ? [] : [ids]) {
          const got = kindById.get(id as string);
          if (!got) err(`${field}: ${id} doesn't exist`);
          else if (got !== want) err(`${field}: ${id} is a ${got}, not a ${want}`);
          else if (id === item.id) err(`${field}: an item can't link to itself`);
        }
      };

      const area = item.productArea as string | undefined;
      if (area && !areaIds.has(area)) warn(`productArea "${area}" isn't in config.yml productAreas`);

      switch (kind) {
        case "hypothesis":
          link("insightIds", "insight", item.insightIds);
          if (!(item.insightIds as unknown[] | undefined)?.length) warn("no insights linked: what evidence is this built on?");
          break;
        case "experiment":
          link("hypothesisId", "hypothesis", item.hypothesisId);
          break;
        case "finding":
          link("experimentIds", "experiment", item.experimentIds);
          link("hypothesisIds", "hypothesis", item.hypothesisIds);
          link("insightIds", "insight", item.insightIds);
          if (![item.experimentIds, item.hypothesisIds, item.insightIds].some((l) => (l as unknown[] | undefined)?.length)) {
            warn("no evidence linked: link the experiments, hypotheses or insights behind it");
          }
          break;
        case "requirement": {
          const r = item as unknown as Requirement;
          link("findingIds", "finding", r.findingIds);
          link("insightIds", "insight", r.insightIds);
          link("hypothesisIds", "hypothesis", r.hypothesisIds);
          link("stakeholderIds", "requirement", r.stakeholderIds);
          link("obsoletedBy", "requirement", r.obsoletedBy);
          for (const id of r.stakeholderIds ?? []) {
            const t = s.requirements.find((x) => x.id === id);
            if (t && kindOf(t) !== "stakeholder") err(`stakeholderIds: ${id} is a solution requirement, not a stakeholder requirement`);
          }
          if (r.stakeholderIds?.length && kindOf(r) === "stakeholder") err("stakeholderIds is only for solution requirements");
          if (!r.findingIds?.length && !r.origin) err("needs findingIds, or an origin (tender, regulation, contract, customer-need) if it was decided elsewhere");
          if (r.product && config.products.length && !config.products.includes(r.product)) warn(`product "${r.product}" isn't in config.yml products`);
          if (r.approver && !people.has(r.approver)) warn(`approver "${r.approver}" isn't in config.yml people`);
          break;
        }
      }
    }
  }
  return out;
}
