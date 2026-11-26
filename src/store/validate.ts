import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Collections } from "../core/collections";
import { fulfilledBy, isActive, kindOf, layerProblem, wordingWarnings } from "../core/requirements";
import { EXPERIMENT_STATUS, HYPOTHESIS_STATUS, REQUIREMENT_KIND, localSchemas, type Kind } from "../core/schemas";
import type { CodeTestLink, Requirement, Risk, TestCaseLink, Ticket } from "../core/types";
import { caseKey } from "../core/test-links";
import { initialLevel } from "../core/risk";
import { catalogueOf, findProduct, plannedVersions, productOf } from "./catalogue";
import { CONFIG_FILE, DIR, matrixOf, type Config } from "./config";
import { COLLECTIONS, type Loaded } from "./files";

export interface Problem {
  level: "error" | "warning";
  file: string;
  message: string;
}

const REQUIREMENT_STATUS = z.enum(["draft", "awaiting-approval", "approved", "in-delivery", "obsolete"]);
const { insightInput, hypothesisInput, experimentInput, findingInput, requirementInput, riskInput } = localSchemas;

/** What a stored item must look like: the agent's input shape plus the fields Groundwork sets. Unknown fields are kept. */
const STORED: Record<Kind, z.ZodType> = {
  insight: insightInput.extend({ createdAt: z.string() }).loose(),
  hypothesis: hypothesisInput.extend({ status: HYPOTHESIS_STATUS, knowWhen: z.string().optional() }).loose(),
  experiment: experimentInput.extend({ status: EXPERIMENT_STATUS }).loose(),
  finding: findingInput.loose(),
  requirement: requirementInput
    .extend({ kind: REQUIREMENT_KIND.optional(), status: REQUIREMENT_STATUS, acceptanceCriteria: z.array(z.string()).default([]) })
    .loose(),
  risk: riskInput
    .extend({
      createdAt: z.string().optional(),
      mitigationIds: z.array(z.string()).default([]),
      origin: z.enum(["existing-product"]).optional(),
      originNote: z.string().optional(),
    })
    .loose(),
};

/** Every problem in a project: unreadable files, invalid fields, broken or wrong-kind links, unknown areas. */
export function validate(loaded: Loaded, config: Config, opts: { root?: string } = {}): Problem[] {
  const out: Problem[] = loaded.problems.map((p) => ({ level: "error", ...p }));
  const s: Collections = loaded.items;
  const kindById = new Map<string, Kind>();
  for (const kind of Object.keys(COLLECTIONS) as Kind[]) for (const x of s[COLLECTIONS[kind]] as { id: string }[]) kindById.set(x.id, kind);
  const catalogue = catalogueOf(config, loaded.products);
  const areaIds = new Set(catalogue.areas.map((a) => a.id));
  const where = catalogue.legacy || !catalogue.products.length ? "config.yml productAreas" : "any product in groundwork/products/";

  // Product files: area ids unique across products, version strings unique within a product.
  const areaOwner = new Map<string, string>();
  for (const p of loaded.products) {
    const file = loaded.paths.get(p.id) ?? p.id;
    for (const a of p.areas) {
      const owner = areaOwner.get(a.id);
      if (owner && owner !== p.id) out.push({ level: "error", file, message: `productArea "${a.id}" is defined by both ${owner} and ${p.id}` });
      else areaOwner.set(a.id, p.id);
    }
    const seen = new Set<string>();
    for (const v of p.versions) {
      if (seen.has(v.version)) out.push({ level: "error", file, message: `version "${v.version}" is listed twice` });
      seen.add(v.version);
    }
  }
  if (loaded.products.length && (config.productAreas.length || config.products.length)) {
    out.push({ level: "warning", file: `${DIR}/${CONFIG_FILE}`, message: "config.yml productAreas/products are ignored: products live in groundwork/products/" });
  }
  const people = new Set(config.people.map((p) => p.id));
  const matrix = matrixOf(config);

  /** Version references on a requirement: they must be versions of its product, in the right state. */
  const checkVersions = (r: Requirement, err: (m: string) => void, warn: (m: string) => void) => {
    const fields = ["plannedFor", "obsoletePlannedFor", "releasedIn", "obsoletedIn"] as const;
    if (kindOf(r) === "stakeholder") {
      if (r.plannedFor || r.releasedIn || r.obsoletedIn) err("only solution requirements are planned for versions");
      return;
    }
    const p = productOf(catalogue, r);
    if (!p) return;
    for (const f of fields) {
      const v = r[f];
      if (v && !p.versions.some((x) => x.version === v)) err(`${f} "${v}" isn't a version of ${p.title}`);
    }
    const status = (v: string | undefined) => p.versions.find((x) => x.version === v)?.status;
    if (r.releasedIn && status(r.releasedIn) === "planned") err(`releasedIn "${r.releasedIn}" isn't released yet`);
    if (r.obsoletedIn && status(r.obsoletedIn) === "planned") err(`obsoletedIn "${r.obsoletedIn}" isn't released yet`);
    if (r.releasedIn && (!r.releasedAt || !r.releasedBy)) warn(`released in ${r.releasedIn} without releasedAt and releasedBy`);
    if (r.obsoletedIn) {
      for (const id of r.obsoletedBy ?? []) {
        const by = s.requirements.find((x) => x.id === id);
        if (by && !by.releasedIn) warn(`obsolete in ${r.obsoletedIn}, but ${id} that replaces it hasn't shipped`);
      }
    }
    if (!isActive(r)) return;
    if (r.obsoletePlannedFor && status(r.obsoletePlannedFor) === "released") warn(`planned to become obsolete in ${r.obsoletePlannedFor}, which is already released`);
    const approved = r.status === "approved" || r.status === "in-delivery";
    if (approved && !r.plannedFor && !r.releasedIn && plannedVersions(p).length) {
      err(`approved but not planned for a version of ${p.title}: plan it with plan_requirements`);
    }
    if (r.plannedFor && !r.releasedIn && status(r.plannedFor) === "released") {
      warn(`planned for ${r.plannedFor}, which is released, but not released in it`);
    }
  };

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

      if (opts.root && (kind === "requirement" || kind === "hypothesis" || kind === "risk")) {
        // Malformed values are reported by the schema check above; skip them here.
        for (const ref of Array.isArray(item.codeRefs) ? item.codeRefs : []) {
          if (typeof ref !== "string") continue;
          const path = ref.split("#")[0].replace(/:\d+(?:[-:]\d+)?$/, "");
          if (path && !existsSync(join(opts.root, path))) warn(`codeRefs: ${path} doesn't exist`);
        }
      }

      const area = item.productArea as string | undefined;
      if (area && !areaIds.has(area)) warn(`productArea "${area}" isn't in ${where}`);

      switch (kind) {
        case "hypothesis":
          link("insightIds", "insight", item.insightIds);
          if (item.origin !== "inferred" && !(item.insightIds as unknown[] | undefined)?.length) warn("no insights linked: what evidence is this built on?");
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
          link("replaces", "requirement", r.replaces);
          link("riskIds", "risk", r.riskIds);
          for (const id of r.riskIds ?? []) {
            const k = s.risks.find((x) => x.id === id);
            if (k && !(k.mitigationIds ?? []).includes(r.id)) err(`riskIds: ${id} doesn't list ${r.id} as a mitigation`);
          }
          for (const id of r.stakeholderIds ?? []) {
            const t = s.requirements.find((x) => x.id === id);
            if (t && kindOf(t) !== "stakeholder") err(`stakeholderIds: ${id} is a solution requirement, not a stakeholder requirement`);
          }
          if (isActive(r)) {
            const problem = layerProblem(r);
            if (problem) err(problem);
            if (kindOf(r) === "stakeholder" && !fulfilledBy(r.id, s.requirements).length) {
              warn("not yet fulfilled by any solution requirement");
            }
            wordingWarnings(r).forEach(warn);
          }
          if (r.product && catalogue.products.length) {
            const byTitle = findProduct(catalogue, r.product);
            if (!byTitle) err(`product "${r.product}" isn't a product in groundwork/products/`);
            else if (byTitle.id !== r.product) err(`use the product id ${byTitle.id} instead of its title (groundwork migrate fixes this)`);
          } else if (r.product && config.products.length && !config.products.includes(r.product)) {
            warn(`product "${r.product}" isn't in config.yml products`);
          }
          if (r.approver && !people.has(r.approver)) warn(`approver "${r.approver}" isn't in config.yml people`);
          checkVersions(r, err, warn);
          const codeTests = r.codeTests as unknown;
          const cases = r.testCases as unknown;
          if ((Array.isArray(codeTests) && codeTests.length) || (Array.isArray(cases) && cases.length)) {
            if (kindOf(r) === "stakeholder") err("tests on a stakeholder requirement: link them to the solution requirements that fulfil it");
          }
          for (const t of (Array.isArray(codeTests) ? codeTests : []) as Partial<CodeTestLink>[]) {
            if (typeof t?.path !== "string" || typeof t?.name !== "string" || !t.path || !t.name) {
              err("codeTests: a test needs a path and a name");
              continue;
            }
            if (opts.root && !existsSync(join(opts.root, t.path))) warn(`codeTests: ${t.path} doesn't exist`);
          }
          const seenCases = new Set<string>();
          for (const t of (Array.isArray(cases) ? cases : []) as Partial<Record<keyof TestCaseLink, unknown>>[]) {
            if (typeof t?.id === "number") {
              err(`testCases: quote the case id, e.g. id: "${t.id}"`);
              continue;
            }
            if (typeof t?.tool !== "string" || typeof t?.id !== "string" || typeof t?.title !== "string" || !t.tool || !t.id || !t.title) {
              err("testCases: a case needs a tool, an id and a title");
              continue;
            }
            if (t.project !== undefined && typeof t.project !== "string") {
              err(`testCases: project must be text, e.g. project: "${String(t.project)}"`);
              continue;
            }
            const project = t.project as string | undefined;
            const k = caseKey({ tool: t.tool, id: t.id, project });
            if (seenCases.has(k)) warn(`test case ${t.tool.toLowerCase()} ${project ? `${project.toUpperCase()}-` : ""}${t.id} is linked twice`);
            seenCases.add(k);
          }
          const seenTickets = new Set<string>();
          if (r.tickets !== undefined && !Array.isArray(r.tickets)) err("tickets must be a list");
          for (const t of (Array.isArray(r.tickets) ? r.tickets : []) as Partial<Ticket>[]) {
            if (typeof t.tracker !== "string" || typeof t.key !== "string" || !t.tracker || !t.key) {
              err("a ticket needs a tracker and a key, as text");
              continue;
            }
            const k = `${t.tracker.toLowerCase()} ${t.key.toLowerCase()}`;
            if (seenTickets.has(k)) warn(`ticket ${t.key} is linked twice`);
            seenTickets.add(k);
          }
          break;
        }
        case "risk": {
          const k = item as unknown as Risk;
          link("mitigationIds", "requirement", k.mitigationIds);
          for (const field of ["probability", "severity", "residualProbability", "residualSeverity"] as const) {
            const v = k[field];
            if (typeof v === "number" && (!Number.isInteger(v) || v < 1 || v > matrix.size)) {
              err(`${field} ${v} is outside the ${matrix.size}×${matrix.size} risk matrix (1–${matrix.size})`);
            }
          }
          const p = k.product ? loaded.products.find((x) => x.id === k.product) : undefined;
          if (k.product && !p) err(`product "${k.product}" doesn't exist`);
          for (const v of Array.isArray(k.versions) ? k.versions : []) {
            if (p && !p.versions.some((x) => x.version === v)) err(`versions: "${v}" isn't a version of ${p.id}`);
          }
          if (initialLevel(matrix, k) === "high" && !(k.mitigationIds ?? []).length) warn(`high risk "${k.title}" has no mitigating requirement`);
          break;
        }
      }
    }
  }
  return out;
}
