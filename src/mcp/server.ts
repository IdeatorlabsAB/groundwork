import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Collections } from "../core/collections";
import { composeKnowWhen } from "../core/hypothesis";
import * as ops from "../core/ops";
import { canBeReplaced, fulfilledBy, kindOf, layerProblem, wordingWarnings } from "../core/requirements";
import { KIND, localId, localSchemas, type Kind } from "../core/schemas";
import { mergeAreas, mergeProducts, mergeVersions, WorkspaceError } from "../core/workspace";
import type { Experiment, Finding, Hypothesis, Insight, Requirement } from "../core/types";
import { appendToConfig, isInitialized, readConfig, resolveActor, setSchemaVersion, writeConfig, type Config } from "../store/config";
import { nextProductId, writeProduct, type Product } from "../store/products";
import { correctRelease, laterVersion, pendingRelease, ReleaseError, releaseReport, releaseRequirements, releaseVersion, stakeholderProgress } from "../store/release";
import { assignIds, COLLECTIONS, load, newPath, save, type Loaded } from "../store/files";
import { validate } from "../store/validate";
import { catalogueOf, findArea, findProduct, plannedVersions, productOf, type Catalogue } from "../store/catalogue";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

const { insightInput, hypothesisInput, experimentInput, findingInput, requirementInput, PATCHES } = localSchemas;

export const INSTRUCTIONS = `Groundwork keeps this product's evidence and decisions as linked Markdown files in the groundwork/ folder, as a chain:
insight -> hypothesis -> experiment -> finding -> requirement.

- Insight: evidence from a real person: what they said or did (quote), where it came from (source) and who they are (persona). Not opinions or ideas. Never store full names or contact details; use a role and an optional participant ref like P07.
- Hypothesis: "We believe we will [outcome] if [forWhom] get [benefit] with [feature]", built on insights (insightIds), ideally with a successMetric (baseline, target, timeframe).
- Experiment: tests exactly one hypothesis (hypothesisId) with one primary metric and optional guardrails. Lifecycle: planned -> start_experiment -> record_experiment_results (Groundwork computes the verdict and updates the hypothesis).
- Finding: what was learned, linked to the experiments, hypotheses and insights behind it.
- Requirement, in two layers, written before building:
  - "stakeholder": who needs what and why, as a user story: "As a <role> I want <need> so that <reason>".
  - "solution": the qualities and behaviour the solution must have, as "shall" statements: "The <system or part> shall …". Every solution requirement fulfils at least one stakeholder requirement (stakeholderIds); one stakeholder requirement is usually fulfilled by several solution requirements.
  Add the stakeholder requirements first, then the solution requirements that reference their ids. Link findingIds, insightIds or an origin (tender, regulation, contract, customer-need) when there is evidence or an outside source; they're optional.

How to work:
1. Call get_workspace first: it gives the products (with their areas and versions) and people (for approvers). If an area, product or version you need is missing, add it with add_product_areas, add_products or add_product_versions, after checking for an existing match. If it says catalogue is legacy, suggest the user runs groundwork migrate before adding versions.
2. Before creating anything, search_items for duplicates and for evidence to link. Prefer linking to existing items over creating near-duplicates.
3. Always link evidence: hypotheses to insights, experiments to a hypothesis, findings to experiments/hypotheses/insights, solution requirements to the stakeholder requirements they fulfil, and requirements to findings when there are any.
4. Ask the user before deleting items or approving requirements, unless they already told you to.
5. Use these tools rather than editing the files directly: they keep ids unique and links valid. Each result includes the item's file: mention it so the user can open it.
6. The Markdown body under an item's frontmatter is the user's own notes. Read it, but don't overwrite it.

When you plan work (a plan, plan mode, or a step in an autonomous workflow):
1. Classify the task first. If unsure, search_items for related requirements.
   - New need: something users can't do today, e.g. "Let's add a feature to book appointments".
   - Change: existing behaviour that should work differently.
   - Fix: restores intended behaviour, e.g. "This path is broken, fix it". Refactors and dependency bumps count as fixes.
2. State the call in one line of the plan, e.g. "New need: adds 2 stakeholder and 4 solution requirements" or "Bug fix under REQ-0007; no requirement changes".
3. New need: the plan's first steps add the stakeholder requirements, then the solution requirements that fulfil them, before writing code.
4. Change: update the requirement with update_item if it's a draft. If it's approved, add a new one with replaces: [the old id]. When the new one is approved, the old one becomes obsolete in the version the new one ships in (or straight away if the product has no versions).
5. Fix: don't write requirements. Name the requirement the fix restores when you can tell.
6. With no person to review the plan (an autonomous workflow), follow your own call. The one-line call stays in the plan as the record.
7. When the workflow creates tickets or user stories, use the solution requirements and the stakeholder stories they fulfil as a source. Put the REQ ids and each requirement's file path in the ticket. By default, one ticket per solution requirement.
8. Approval given outside Groundwork (e.g. verbally by a PM): record it with approve_requirement, passing approvedBy and a note. Only do this when the user tells you who approved it.

Releasing a version ("Release Clinicare 1.1"):
1. Call get_release for the version.
2. If the workflow has a tracker tool, check each planned requirement's tickets and propose as shipped the ones whose tickets are all done. Without a tracker, ask the user which requirements shipped.
3. Show the user what ships, what becomes obsolete, and where the rest will move. Call release_version only once they agree.
4. A mistake in a released version is fixed with correct_release and the user's reason, never by editing files. Requirements that shipped later go in with release_requirements.

Recording evidence or requirements directly isn't planning work. A product manager logging interview notes, drafting hypotheses, recording experiment results or writing requirements gets no new need / change / fix call: record what they ask for with the tools above.`;

type State = Collections;
type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type AnyItem = Insight | Hypothesis | Experiment | Finding | Requirement;

class UserError extends Error {}

const an = (kind: string) => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
const ok = (value: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): Result => ({ content: [{ type: "text", text: message }], isError: true });

function find(s: State, id: string): { kind: Kind; item: AnyItem } | undefined {
  for (const kind of KIND.options) {
    const item = (s[COLLECTIONS[kind]] as AnyItem[]).find((x) => x.id === id);
    if (item) return { kind, item };
  }
  return undefined;
}

/** The ids each kind links to. */
export function outgoing(kind: Kind, item: AnyItem): string[] {
  switch (kind) {
    case "hypothesis":
      return (item as Hypothesis).insightIds ?? [];
    case "experiment":
      return [(item as Experiment).hypothesisId];
    case "finding": {
      const f = item as Finding;
      return [...(f.experimentIds ?? []), ...(f.hypothesisIds ?? []), ...(f.insightIds ?? [])];
    }
    case "requirement": {
      const r = item as Requirement;
      return [...(r.findingIds ?? []), ...(r.insightIds ?? []), ...(r.hypothesisIds ?? []), ...(r.stakeholderIds ?? []), ...(r.obsoletedBy ?? []), ...(r.replaces ?? [])];
    }
    default:
      return [];
  }
}

const statusOf = (kind: Kind, item: AnyItem): string | undefined =>
  kind === "hypothesis" || kind === "experiment" || kind === "requirement" ? (item as { status: string }).status : undefined;

function textOf(kind: Kind, item: AnyItem): string {
  const notes = (item as { notes?: string }).notes ?? "";
  switch (kind) {
    case "insight": {
      const i = item as Insight;
      return [i.title, i.quote, i.persona, (i.tags ?? []).join(" "), notes].join(" ");
    }
    case "hypothesis": {
      const h = item as Hypothesis;
      return [h.title, h.outcome, h.forWhom, h.benefit, h.feature, h.knowWhen, notes].join(" ");
    }
    case "experiment": {
      const e = item as Experiment;
      return [e.title, e.description, e.primaryMetric?.name, e.resultNotes ?? "", notes].join(" ");
    }
    case "finding": {
      const f = item as Finding;
      return [f.title, f.summary, notes].join(" ");
    }
    case "requirement": {
      const r = item as Requirement;
      return [r.title, r.story, r.stakeholder ?? "", r.product ?? "", (r.acceptanceCriteria ?? []).join(" "), notes].join(" ");
    }
  }
}

/** One tool call's view of the project: config, actor and the files as they are on disk right now. */
class Session {
  readonly config: Config;
  readonly loaded: Loaded;
  readonly actor: ReturnType<typeof resolveActor>;
  readonly catalogue: Catalogue;

  constructor(readonly root: string) {
    this.config = readConfig(root);
    this.loaded = load(root);
    this.actor = resolveActor(root, this.config);
    this.catalogue = catalogueOf(this.config, this.loaded.products);
  }

  file(kind: Kind, item: AnyItem) {
    return this.loaded.paths.get(item.id) ?? newPath(kind, item.id, item.title);
  }

  areaLabel = (id: string | undefined) => this.catalogue.areas.find((a) => a.id === id)?.label ?? "";

  /** Accept an area's id or label; undefined stays undefined. */
  area(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const a = findArea(this.catalogue, value);
    if (!a) {
      const known = this.catalogue.areas.map((x) => x.label).join(", ") || "none defined";
      const where = this.catalogue.products.length ? "Areas of the products in groundwork/products/" : "Areas in groundwork/config.yml";
      throw new UserError(`Unknown product area "${value}". ${where}: ${known}. Add it with add_product_areas, or leave it out.`);
    }
    return a.id;
  }

  /** Check that `version` is a planned version of the requirement's product, and return it. */
  checkPlanned(r: Requirement, version: string): string {
    if (kindOf(r) === "stakeholder") throw new UserError("only solution requirements are planned for versions");
    const p = productOf(this.catalogue, r);
    if (!p) {
      throw new UserError(
        this.catalogue.products.length > 1
          ? `"${r.title}" has no product, and there's more than one: set its product first.`
          : `"${r.title}" has no product with versions. Add versions with add_product_versions.`,
      );
    }
    const planned = plannedVersions(p);
    if (!planned.includes(version)) {
      throw new UserError(`${version} isn't a planned version of ${p.title}. Planned: ${planned.join(", ") || "none"}. Add one with add_product_versions.`);
    }
    return version;
  }

  /**
   * A requirement planned through the "only product" fallback gets that product written down, so it still knows its
   * product (and whose versions it names) once a second product is added.
   */
  pinProduct(state: State, id: string): State {
    const r = state.requirements.find((x) => x.id === id);
    if (!r || r.product) return state;
    const p = productOf(this.catalogue, r);
    return p ? { ...state, requirements: state.requirements.map((x) => (x.id === id ? { ...x, product: p.id } : x)) } : state;
  }

  /** The later of two versions in the requirement's product's release order (list order). */
  laterVersion(r: Requirement, a: string | undefined, b: string): string {
    return laterVersion(productOf(this.catalogue, r), a, b);
  }

  /** The version an approval plans the requirement for: required for a solution requirement once its product has planned versions. */
  planOnApproval(r: Requirement, plannedFor: string | undefined): string | undefined {
    if (plannedFor) return this.checkPlanned(r, plannedFor);
    if (kindOf(r) === "stakeholder") return undefined;
    const p = productOf(this.catalogue, r);
    const planned = p ? plannedVersions(p) : [];
    if (planned.length) throw new UserError(`Which version is "${r.title}" planned for? Pass plannedFor: one of ${planned.join(", ")}.`);
    return undefined;
  }

  /** The product a product-level change is for: the named one, or the only one. */
  targetProduct(value: string | undefined): Product {
    const products = this.catalogue.products;
    if (!products.length) throw new UserError("Add a product first with add_products.");
    if (value) {
      const p = findProduct(this.catalogue, value);
      if (!p) throw new UserError(`Unknown product "${value}". Products: ${this.catalogue.productNames.join(", ")}.`);
      return p;
    }
    if (products.length > 1) throw new UserError(`Name the product: one of ${products.map((p) => `${p.id} (${p.title})`).join(", ")}.`);
    return products[0];
  }

  /** A requirement's product as stored: the product id with product files, the config spelling for legacy projects. */
  product(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (this.catalogue.products.length) {
      const p = findProduct(this.catalogue, value);
      if (!p) {
        throw new UserError(`Unknown product "${value}". Products: ${this.catalogue.productNames.join(", ")}. Add it with add_products, or leave it out.`);
      }
      return p.id;
    }
    if (!this.catalogue.legacy) throw new UserError(`No products yet, so "${value}" can't be used. Add a product first with add_products, or leave product out.`);
    const names = this.catalogue.productNames;
    const hit = names.find((p) => p.toLowerCase() === value.trim().toLowerCase());
    if (names.length && !hit) {
      throw new UserError(`Unknown product "${value}". Products in groundwork/config.yml: ${names.join(", ")}. Add it with add_products, or leave it out.`);
    }
    return hit ?? value;
  }

  /** Every id must be an item of this kind. */
  check(s: State, kind: Kind, ids: string[] | undefined, field: string) {
    for (const id of ids ?? []) {
      const hit = find(s, id);
      if (!hit) throw new UserError(`${field}: no item with id ${id}.`);
      if (hit.kind !== kind) throw new UserError(`${field}: ${id} is ${an(hit.kind)}, not ${an(kind)}.`);
    }
  }

  /**
   * A requirement can replace only approved ones (drafts are updated in place, obsolete ones are gone already), not
   * itself, and only within its own product: the old one becomes obsolete in a version of that product.
   */
  checkReplaces(s: State, ids: string[] | undefined, by: Pick<Requirement, "kind" | "product"> & { id?: string }) {
    this.check(s, "requirement", ids, "replaces");
    for (const id of ids ?? []) {
      if (id === by.id) throw new UserError("A requirement can't replace itself.");
      const r = s.requirements.find((x) => x.id === id)!;
      if (kindOf(by) === "solution" && kindOf(r) === "solution") {
        const mine = productOf(this.catalogue, by);
        const theirs = productOf(this.catalogue, r);
        if (mine && theirs && mine.id !== theirs.id) {
          throw new UserError(`Can't replace "${r.title}": it belongs to another product (${theirs.title}). Make it obsolete there with obsolete_requirement.`);
        }
      }
      if (r.status === "draft") throw new UserError(`"${r.title}" is a draft: update it instead of replacing it.`);
      if (r.status === "obsolete") throw new UserError(`"${r.title}" is already obsolete.`);
      if (!canBeReplaced(r)) throw new UserError(`"${r.title}" is ${r.status}; only approved requirements can be replaced.`);
    }
  }

  checkStakeholders(s: State, ids: string[] | undefined) {
    this.check(s, "requirement", ids, "stakeholderIds");
    for (const id of ids ?? []) {
      const r = s.requirements.find((x) => x.id === id)!;
      if (kindOf(r) !== "stakeholder") throw new UserError(`stakeholderIds: "${r.title}" is a solution requirement, not a stakeholder requirement.`);
    }
  }

  summary(kind: Kind, item: AnyItem) {
    const area = this.areaLabel((item as { productArea?: string }).productArea) || undefined;
    return {
      kind,
      id: item.id,
      title: item.title,
      ...(statusOf(kind, item) ? { status: statusOf(kind, item) } : {}),
      ...(kind === "requirement" ? { requirementKind: kindOf(item as Requirement) } : {}),
      ...(area ? { area } : {}),
      file: this.file(kind, item),
    };
  }

  full(kind: Kind, item: AnyItem) {
    const area = this.areaLabel((item as { productArea?: string }).productArea) || undefined;
    return { kind, ...item, ...(area ? { areaLabel: area } : {}), file: this.file(kind, item) };
  }

  ctx(): ops.Ctx {
    // Temporary ids; the store swaps them for readable ones (INS-0008…) when it saves.
    return { actor: this.actor.id, now: new Date().toISOString(), newId: () => `new-${randomUUID()}` };
  }

  canEdit() {
    return !this.actor.person || this.actor.person.role !== "viewer";
  }
}

export interface ServerOptions {
  /** The project folder (the one that holds groundwork/). */
  root: string;
}

export function buildServer({ root }: ServerOptions): McpServer {
  const server = new McpServer({ name: "groundwork", version: VERSION }, { instructions: INSTRUCTIONS });

  const open = () => new Session(root);

  const read =
    <A>(fn: (s: Session, args: A) => unknown) =>
    async (args: A): Promise<Result> => {
      try {
        return ok(await fn(open(), args));
      } catch (e) {
        return fail(e instanceof UserError ? e.message : `Groundwork couldn't read the project: ${(e as Error).message}`);
      }
    };

  /** Why this session may not write, if it may not. */
  const refusal = (s: Session): string | undefined => {
    if (s.config.migrated) {
      return `This folder was imported into the Groundwork web app (${s.config.migrated}), which is now where changes go. Connect its MCP server instead (Groundwork → Settings → Connect an agent). These files are kept as a read-only record.`;
    }
    if (!s.canEdit()) return `${s.actor.person?.name ?? s.actor.id} is a viewer in groundwork/config.yml, so this agent can't change anything.`;
    return undefined;
  };

  /**
   * Add product areas or products to groundwork/config.yml; no item files are touched. An existing file is edited in
   * place (comments and unknown keys kept) and left alone when nothing is new.
   */
  const writeConfigOnly =
    <A>(fn: (s: Session, args: A) => { add: { productAreas?: Config["productAreas"]; products?: string[] }; result: unknown }) =>
    async (args: A): Promise<Result> => {
      try {
        const s = open();
        const refused = refusal(s);
        if (refused) return fail(refused);
        const { add, result } = fn(s, args);
        if (!isInitialized(root)) {
          writeConfig(root, {
            ...s.config,
            productAreas: [...s.config.productAreas, ...(add.productAreas ?? [])],
            products: [...s.config.products, ...(add.products ?? [])],
          });
        } else if (add.productAreas?.length || add.products?.length) {
          appendToConfig(root, add);
        }
        return ok({ ...(result as object), file: "groundwork/config.yml" });
      } catch (e) {
        if (e instanceof UserError || e instanceof WorkspaceError) return fail(e.message);
        return fail(`Groundwork couldn't save that: ${(e as Error).message}`);
      }
    };

  /**
   * Create or change product files (groundwork/products/). The first product file moves config.yml to
   * schemaVersion 2: older groundwork-mcp versions don't know where products live.
   */
  const writeProducts =
    <A>(fn: (s: Session, args: A) => { write: Product[]; result: Record<string, unknown> }) =>
    async (args: A): Promise<Result> => {
      try {
        const s = open();
        const refused = refusal(s);
        if (refused) return fail(refused);
        const { write, result } = fn(s, args);
        if (!isInitialized(root)) writeConfig(root, s.config);
        const files = write.map((p) => writeProduct(root, p, s.loaded.paths.get(p.id)));
        if (files.length) setSchemaVersion(root, 2);
        return ok({ ...result, filesChanged: files });
      } catch (e) {
        if (e instanceof UserError || e instanceof WorkspaceError) return fail(e.message);
        return fail(`Groundwork couldn't save that: ${(e as Error).message}`);
      }
    };
  /** Legacy projects (flat lists in config.yml) keep their old behaviour; everything else uses product files. */
  const usesProductFiles = () => !open().catalogue.legacy;

  /**
   * Run a change against the files as they are now: `fn` returns the new state and what to tell the agent. New
   * items get readable ids, and only the files that changed are written.
   */
  const write =
    <A>(fn: (s: Session, state: State, ctx: ops.Ctx, args: A) => { state: State; result: unknown; products?: Product[] }) =>
    async (args: A): Promise<Result> => {
      try {
        const s = open();
        const refused = refusal(s);
        if (refused) return fail(refused);
        if (!isInitialized(root)) writeConfig(root, s.config);
        const { state, result, products } = fn(s, s.loaded.items, s.ctx(), args);
        const { items, renamed } = assignIds(s.loaded.items, state);
        const files = save(root, s.loaded, items);
        for (const p of products ?? []) files.push(writeProduct(root, p, s.loaded.paths.get(p.id)));
        let text = JSON.stringify({ ...(result as object), filesChanged: files }, null, 2);
        renamed.forEach((to, from) => (text = text.split(from).join(to)));
        return { content: [{ type: "text", text }] };
      } catch (e) {
        if (e instanceof UserError || e instanceof ReleaseError) return fail(e.message);
        return fail(`Groundwork couldn't save that: ${(e as Error).message}`);
      }
    };

  const apply = <R>(state: State, change: ops.Change<R>): [State, R] => [{ ...state, ...change.next }, change.result];
  const itemId = localId.describe("An item id, e.g. INS-0007.");

  // -------------------------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------------------------

  server.registerTool(
    "get_workspace",
    {
      title: "Get workspace",
      description: "The project's name, its products with their areas and versions, people, item counts and any file problems. Call this first.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    read((s) => {
      const items = s.loaded.items;
      const problems = validate(s.loaded, s.config);
      return {
        workspace: s.config.name,
        folder: `${s.root}/groundwork`,
        initialized: isInitialized(root),
        ...(s.config.migrated ? { migratedTo: s.config.migrated, readOnly: true } : {}),
        you: { id: s.actor.id, name: s.actor.person?.name, role: s.actor.person?.role ?? "editor" },
        catalogue: s.catalogue.legacy ? "legacy" : "files",
        ...(s.catalogue.legacy ? { migrate: "Run groundwork migrate to move products into groundwork/products/ and add versions." } : {}),
        products: s.catalogue.products.length
          ? s.catalogue.products.map(({ id, title, areas, versions }) => ({ id, title, areas, versions }))
          : s.catalogue.productNames.map((title) => ({ title, areas: [], versions: [] })),
        productAreas: s.catalogue.areas,
        members: s.config.people.map(({ id, name, role }) => ({ id, name, role })),
        counts: Object.fromEntries(KIND.options.map((k) => [k, items[COLLECTIONS[k]].length])),
        problems: {
          errors: problems.filter((p) => p.level === "error").length,
          warnings: problems.filter((p) => p.level === "warning").length,
          first: problems.slice(0, 10),
        },
      };
    }),
  );

  server.registerTool(
    "search_items",
    {
      title: "Search items",
      description:
        "Find insights, hypotheses, experiments, findings or requirements. Matches every word of `query` against titles, main text and notes. Returns short summaries; use get_item for the full item and its links.",
      inputSchema: {
        kind: KIND.optional().describe("Only this kind."),
        query: z.string().max(200).optional().describe("Words to match, any order."),
        status: z.string().max(40).optional().describe("Only items with this status, e.g. draft, testing, running, awaiting-approval."),
        area: z.string().max(100).optional().describe("Only items in this product area (label or id)."),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    read((s, { kind, query, status, area, limit }: { kind?: Kind; query?: string; status?: string; area?: string; limit: number }) => {
      const areaId = s.area(area);
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const out: ReturnType<Session["summary"]>[] = [];
      let total = 0;
      for (const k of kind ? [kind] : KIND.options) {
        for (const item of s.loaded.items[COLLECTIONS[k]] as AnyItem[]) {
          if (status && statusOf(k, item) !== status) continue;
          if (areaId && (item as { productArea?: string }).productArea !== areaId) continue;
          if (words.length) {
            const text = textOf(k, item).toLowerCase();
            if (!words.every((w) => text.includes(w))) continue;
          }
          total++;
          if (out.length < limit) out.push(s.summary(k, item));
        }
      }
      return { total, shown: out.length, items: out };
    }),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description: "One item in full, with its notes, the items it links to and the items that link to it.",
      inputSchema: { id: itemId },
      annotations: { readOnlyHint: true },
    },
    read((s, { id }: { id: string }) => {
      const items = s.loaded.items;
      const hit = find(items, id);
      if (!hit) throw new UserError(`No item with id ${id}.`);
      const linksTo = outgoing(hit.kind, hit.item)
        .map((x) => find(items, x))
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .map((x) => s.summary(x.kind, x.item));
      const linkedFrom: ReturnType<Session["summary"]>[] = [];
      for (const k of KIND.options) {
        for (const item of items[COLLECTIONS[k]] as AnyItem[]) if (outgoing(k, item).includes(id)) linkedFrom.push(s.summary(k, item));
      }
      if (hit.kind === "requirement" && kindOf(hit.item as Requirement) === "stakeholder") {
        const fulfilling = fulfilledBy(id, items.requirements).map((x) => s.summary("requirement", x));
        return {
          item: s.full(hit.kind, hit.item),
          fulfilledBy: fulfilling,
          progress: stakeholderProgress(items.requirements, id, s.catalogue),
          ...(fulfilling.length ? {} : { warnings: ["Not yet fulfilled by any solution requirement."] }),
          linksTo,
          linkedFrom,
        };
      }
      return { item: s.full(hit.kind, hit.item), linksTo, linkedFrom };
    }),
  );

  // -------------------------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------------------------

  server.registerTool(
    "add_insights",
    {
      title: "Add insights",
      description: "Log customer evidence: one insight per distinct pain, need or behaviour, each with the quote that shows it.",
      inputSchema: { insights: z.array(insightInput).min(1).max(50) },
    },
    write((s, state, c, { insights }: { insights: z.infer<typeof insightInput>[] }) => {
      const items = insights.map((i) => ({ ...i, productArea: s.area(i.productArea) }));
      const [next, created] = apply(state, ops.addInsights(state, c, items));
      return { state: next, result: { created: created.map((x) => s.summary("insight", x)) } };
    }),
  );

  server.registerTool(
    "add_hypotheses",
    {
      title: "Add hypotheses",
      description: 'Draft hypotheses in the form "We believe we will [outcome] if [forWhom] get [benefit] with [feature]", linked to the insights behind them.',
      inputSchema: { hypotheses: z.array(hypothesisInput).min(1).max(20) },
    },
    write((s, state, c, { hypotheses }: { hypotheses: z.infer<typeof hypothesisInput>[] }) => {
      const items: ops.NewHypothesis[] = hypotheses.map((h) => {
        s.check(state, "insight", h.insightIds, "insightIds");
        return {
          ...h,
          knowWhen: composeKnowWhen({ successMetric: h.successMetric, guardrail: h.guardrail }) || h.knowWhen || "",
          productArea: s.area(h.productArea),
          status: "draft",
          aiGenerated: true,
        };
      });
      const [next, created] = apply(state, ops.addHypotheses(state, c, items));
      return { state: next, result: { created: created.map((x) => s.summary("hypothesis", x)) } };
    }),
  );

  server.registerTool(
    "add_experiment",
    {
      title: "Add experiment",
      description: "Design an experiment for one hypothesis. It starts as planned; call start_experiment when it begins.",
      inputSchema: { experiment: experimentInput },
    },
    write((s, state, c, { experiment }: { experiment: z.infer<typeof experimentInput> }) => {
      s.check(state, "hypothesis", [experiment.hypothesisId], "hypothesisId");
      const [next, created] = apply(state, ops.addExperiment(state, c, { ...experiment, status: "planned", aiGenerated: true }));
      return { state: next, result: { created: s.summary("experiment", created) } };
    }),
  );

  server.registerTool(
    "add_findings",
    {
      title: "Add findings",
      description: "Record what was learned, linked to the experiments, hypotheses and insights behind it.",
      inputSchema: { findings: z.array(findingInput).min(1).max(20) },
    },
    write((s, state, c, { findings }: { findings: z.infer<typeof findingInput>[] }) => {
      const items = findings.map((f) => {
        s.check(state, "experiment", f.experimentIds, "experimentIds");
        s.check(state, "hypothesis", f.hypothesisIds, "hypothesisIds");
        s.check(state, "insight", f.insightIds, "insightIds");
        return { ...f, productArea: s.area(f.productArea), aiGenerated: true };
      });
      const [next, created] = apply(state, ops.addFindings(state, c, items));
      return { state: next, result: { created: created.map((x) => s.summary("finding", x)) } };
    }),
  );

  server.registerTool(
    "add_requirements",
    {
      title: "Add requirements",
      description:
        'Add requirements as drafts. Stakeholder requirements are user stories ("As a <role> I want <need> so that <reason>"). Solution requirements are "shall" statements and must list the stakeholder requirements they fulfil in stakeholderIds, so add the stakeholder requirements first, in an earlier call. findingIds, insightIds and origin are optional evidence. The result lists wording warnings, if any. To ask for sign-off afterwards, use submit_requirement_for_approval.',
      inputSchema: { requirements: z.array(requirementInput).min(1).max(30) },
    },
    write((s, state, c, { requirements }: { requirements: z.infer<typeof requirementInput>[] }) => {
      let next = state;
      const created: Requirement[] = [];
      const derived: ops.DerivedRequirement[] = [];
      const warnings: string[] = [];
      for (const r of requirements) {
        const problem = layerProblem(r);
        if (problem) throw new UserError(`"${r.title}": ${problem}.`);
        wordingWarnings(r).forEach((w) => warnings.push(`"${r.title}": ${w}.`));
        s.check(state, "finding", r.findingIds, "findingIds");
        s.check(state, "insight", r.insightIds, "insightIds");
        s.check(state, "hypothesis", r.hypothesisIds, "hypothesisIds");
        s.checkStakeholders(state, r.stakeholderIds);
        const product = s.product(r.product);
        s.checkReplaces(state, r.replaces, { kind: r.kind, product });
        const base = { ...r, ...(product ? { product } : {}), productArea: s.area(r.productArea), aiGenerated: true };
        if (r.findingIds.length) {
          derived.push(base);
        } else {
          const { findingIds: _unused, ...direct } = base;
          void _unused;
          const [after, one] = apply(next, ops.createRequirement(next, c, { ...direct, status: "draft" }));
          next = after;
          created.push(one);
        }
      }
      if (derived.length) {
        const [after, many] = apply(next, ops.addRequirements(next, c, derived));
        next = after;
        created.push(...many);
      }
      return { state: next, result: { created: created.map((x) => s.summary("requirement", x)), ...(warnings.length ? { warnings } : {}) } };
    }),
  );

  server.registerTool(
    "add_product_areas",
    {
      title: "Add product areas",
      description:
        "Add product areas so items can be tagged with them. They go into the product's file in groundwork/products/ (or config.yml for a project that hasn't migrated). Give labels; ids are made from them unless you pass one. Area ids are unique across products. Areas already there are skipped. Check get_workspace first and reuse an existing area rather than adding a near-duplicate. Can't rename or remove areas: those are edits to the files.",
      inputSchema: {
        product: z.string().max(100).optional().describe("The product's id or title. Needed when there's more than one product."),
        areas: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(100),
              id: z.string().trim().max(40).optional().describe("Optional: lowercase letters, digits and dashes. Made from the label if left out."),
            }),
          )
          .min(1)
          .max(20),
      },
    },
    (args: { areas: { label: string; id?: string }[]; product?: string }) =>
      usesProductFiles()
        ? writeProducts((s, { areas, product }: typeof args) => {
            const p = s.targetProduct(product);
            const { list, added, alreadyThere } = mergeAreas(p.areas, areas);
            for (const a of added) {
              const other = s.catalogue.products.find((x) => x.id !== p.id && x.areas.some((y) => y.id === a.id));
              if (other) throw new UserError(`"${a.label}" would get the id "${a.id}", which ${other.title} already uses. Area ids are unique across products: give a different id.`);
            }
            return { write: added.length ? [{ ...p, areas: list }] : [], result: { product: p.id, added, alreadyThere, productAreas: list } };
          })(args)
        : writeConfigOnly((s, { areas }: typeof args) => {
            const { list, added, alreadyThere } = mergeAreas(s.config.productAreas, areas);
            return { add: { productAreas: added }, result: { added, alreadyThere, productAreas: list } };
          })(args),
  );

  server.registerTool(
    "add_products",
    {
      title: "Add products",
      description:
        "Add products, each as a file in groundwork/products/ (or to config.yml for a project that hasn't migrated), so requirements can name them and areas and versions can be added to them. Products already there are skipped. Check get_workspace first and reuse an existing name rather than adding a near-duplicate.",
      inputSchema: { products: z.array(z.string().trim().min(1).max(100)).min(1).max(20) },
    },
    (args: { products: string[] }) =>
      usesProductFiles()
        ? writeProducts((s, { products }: typeof args) => {
            const { added, alreadyThere } = mergeProducts(s.catalogue.productNames, products);
            const created: Product[] = [];
            for (const title of added) created.push({ id: nextProductId([...s.catalogue.products, ...created]), title, areas: [], versions: [] });
            return {
              write: created,
              result: { added: created.map(({ id, title }) => ({ id, title })), alreadyThere, products: [...s.catalogue.productNames, ...added] },
            };
          })(args)
        : writeConfigOnly((s, { products }: typeof args) => {
            const { list, added, alreadyThere } = mergeProducts(s.config.products, products);
            return { add: { products: added }, result: { added, alreadyThere, products: list } };
          })(args),
  );

  server.registerTool(
    "add_product_versions",
    {
      title: "Add product versions",
      description:
        "Add planned versions to a product, in release order (e.g. 1.0, then 1.1). Versions already listed are skipped. Needs product files: if get_workspace says catalogue is legacy, the user must run groundwork migrate first.",
      inputSchema: {
        product: z.string().max(100).optional().describe("The product's id or title. Needed when there's more than one product."),
        versions: z
          .array(
            z.object({
              version: z.string().trim().min(1).max(40),
              plannedFor: z.string().trim().max(40).optional().describe("Target release date, e.g. 2027-03-01."),
            }),
          )
          .min(1)
          .max(20),
      },
    },
    (args: { product?: string; versions: { version: string; plannedFor?: string }[] }) =>
      writeProducts((s, { product, versions }: typeof args) => {
        if (s.catalogue.legacy) throw new UserError('Run "groundwork migrate" first: products and their versions now live in groundwork/products/.');
        const p = s.targetProduct(product);
        const { list, added, alreadyThere } = mergeVersions(p.versions, versions);
        return { write: added.length ? [{ ...p, versions: list as Product["versions"] }] : [], result: { product: p.id, added, alreadyThere, versions: list } };
      })(args),
  );

  // -------------------------------------------------------------------------------------------
  // Change
  // -------------------------------------------------------------------------------------------

  server.registerTool(
    "update_item",
    {
      title: "Update item",
      description:
        "Change fields of an existing item. `patch` takes the same fields as the add_ tool for that kind (only the ones to change; arrays replace the old value). Requirement status changes have their own tools.",
      inputSchema: { id: itemId, patch: z.record(z.string(), z.unknown()) },
    },
    write((s, state, c, { id, patch }: { id: string; patch: Record<string, unknown> }) => {
      const hit = find(state, id);
      if (!hit) throw new UserError(`No item with id ${id}.`);
      const parsed = PATCHES[hit.kind].strict().safeParse(patch);
      if (!parsed.success) throw new UserError(`Invalid patch for ${an(hit.kind)}: ${z.prettifyError(parsed.error)}`);
      const p = parsed.data as Record<string, unknown> & { productArea?: string };
      if (!Object.keys(p).length) throw new UserError("The patch has no fields to change.");
      if ("productArea" in p) p.productArea = s.area(p.productArea);
      if (hit.kind === "requirement" && typeof p.product === "string") p.product = s.product(p.product);
      const warnings: string[] = [];
      let change: ops.Change;
      switch (hit.kind) {
        case "insight":
          change = ops.updateInsight(state, id, p as Partial<Insight>);
          break;
        case "hypothesis": {
          s.check(state, "insight", p.insightIds as string[] | undefined, "insightIds");
          const merged = { ...(hit.item as Hypothesis), ...p } as Hypothesis;
          if ("successMetric" in p || "guardrail" in p) {
            const composed = composeKnowWhen({ successMetric: merged.successMetric, guardrail: merged.guardrail });
            if (composed) p.knowWhen = composed;
          }
          change = ops.updateHypothesis(state, c, id, p as Partial<Hypothesis>);
          break;
        }
        case "experiment":
          change = ops.updateExperiment(state, id, p as Partial<Experiment>);
          break;
        case "finding":
          s.check(state, "experiment", p.experimentIds as string[] | undefined, "experimentIds");
          s.check(state, "hypothesis", p.hypothesisIds as string[] | undefined, "hypothesisIds");
          s.check(state, "insight", p.insightIds as string[] | undefined, "insightIds");
          change = ops.updateFinding(state, id, p as Partial<Finding>);
          break;
        case "requirement": {
          const r = hit.item as Requirement;
          if (r.status === "obsolete" || r.status === "in-delivery") {
            throw new UserError(`"${r.title}" is ${r.status}, so it can't be edited. Create a new requirement instead.`);
          }
          s.check(state, "finding", p.findingIds as string[] | undefined, "findingIds");
          s.check(state, "insight", p.insightIds as string[] | undefined, "insightIds");
          s.check(state, "hypothesis", p.hypothesisIds as string[] | undefined, "hypothesisIds");
          s.checkStakeholders(state, p.stakeholderIds as string[] | undefined);
          if (p.replaces !== undefined && r.status !== "draft" && r.status !== "awaiting-approval") {
            throw new UserError(`"${r.title}": replaces can be changed only before it's approved. Add a new requirement that replaces it instead.`);
          }
          if (typeof p.product === "string" && (r.plannedFor || r.obsoletePlannedFor)) {
            const was = productOf(s.catalogue, r);
            if (productOf(s.catalogue, { product: p.product as string })?.id !== was?.id) {
              throw new UserError(`"${r.title}" is planned for ${r.plannedFor ?? r.obsoletePlannedFor} of ${was?.title}, so its product can't change. Add a new requirement for the other product instead.`);
            }
          }
          s.checkReplaces(state, p.replaces as string[] | undefined, { ...r, ...(p as Partial<Requirement>) });
          const merged = { ...r, ...(p as Partial<Requirement>) };
          const problem = layerProblem(merged);
          if (problem) throw new UserError(`"${merged.title}": ${problem}.`);
          if (kindOf(r) === "stakeholder" && kindOf(merged) === "solution") {
            const fulfilling = fulfilledBy(id, state.requirements);
            if (fulfilling.length) {
              throw new UserError(`"${r.title}" is fulfilled by ${fulfilling.map((x) => x.id).join(", ")}, so it can't become a solution requirement.`);
            }
          }
          warnings.push(...wordingWarnings(merged).map((w) => `"${merged.title}": ${w}.`));
          change = ops.updateRequirement(state, id, { ...(p as Partial<Requirement>), updatedAt: c.now });
          break;
        }
      }
      const [next] = apply(state, change);
      const updated = find(next, id)!;
      return { state: next, result: { updated: s.full(updated.kind, updated.item), ...(warnings.length ? { warnings } : {}) } };
    }),
  );

  server.registerTool(
    "link_items",
    {
      title: "Link items",
      description:
        "Add evidence links without replacing existing ones. `id` is the item to link from; `linkTo` are the items it builds on. Supported: hypothesis -> insights; finding -> experiments, hypotheses, insights; requirement -> findings, insights, hypotheses, stakeholder requirements (for a solution requirement); experiment -> one hypothesis (replaces it).",
      inputSchema: { id: itemId, linkTo: z.array(localId).min(1).max(50) },
    },
    write((s, state, _c, { id, linkTo }: { id: string; linkTo: string[] }) => {
      const hit = find(state, id);
      if (!hit) throw new UserError(`No item with id ${id}.`);
      const add = (list: string[] | undefined, x: string) => (list?.includes(x) ? list : [...(list ?? []), x]);
      let item = { ...hit.item } as AnyItem & Record<string, unknown>;
      for (const target of linkTo) {
        const t = find(state, target);
        if (!t) throw new UserError(`No item with id ${target}.`);
        if (target === id) throw new UserError("An item can't link to itself.");
        const field =
          hit.kind === "hypothesis" && t.kind === "insight"
            ? "insightIds"
            : hit.kind === "experiment" && t.kind === "hypothesis"
              ? "hypothesisId"
              : hit.kind === "finding" && (t.kind === "experiment" || t.kind === "hypothesis" || t.kind === "insight")
                ? (`${t.kind}Ids` as const)
                : hit.kind === "requirement" && t.kind === "finding"
                  ? "findingIds"
                  : hit.kind === "requirement" && t.kind === "insight"
                    ? "insightIds"
                    : hit.kind === "requirement" && t.kind === "hypothesis"
                      ? "hypothesisIds"
                      : hit.kind === "requirement" &&
                          t.kind === "requirement" &&
                          kindOf(hit.item as Requirement) === "solution" &&
                          kindOf(t.item as Requirement) === "stakeholder"
                        ? "stakeholderIds"
                        : null;
        if (!field) {
          const what = t.kind === "requirement" ? `a ${kindOf(t.item as Requirement)} requirement` : an(t.kind);
          throw new UserError(`${an(hit.kind).replace(/^a/, "A")} can't link to ${what}.`);
        }
        item = field === "hypothesisId" ? { ...item, hypothesisId: target } : { ...item, [field]: add(item[field] as string[] | undefined, target) };
      }
      const key = COLLECTIONS[hit.kind];
      const next = { ...state, [key]: (state[key] as AnyItem[]).map((x) => (x.id === id ? item : x)) } as State;
      return { state: next, result: { updated: s.full(hit.kind, item) } };
    }),
  );

  server.registerTool(
    "start_experiment",
    {
      title: "Start experiment",
      description: "Mark a planned experiment as running. A draft hypothesis it tests moves to testing.",
      inputSchema: { id: itemId },
    },
    write((s, state, c, { id }: { id: string }) => {
      const e = state.experiments.find((x) => x.id === id);
      if (!e) throw new UserError(`No experiment with id ${id}.`);
      if (e.status !== "planned") throw new UserError(`"${e.title}" is already ${e.status}.`);
      const [next] = apply(state, ops.startExperiment(state, c, id));
      return { state: next, result: { started: s.summary("experiment", next.experiments.find((x) => x.id === id)!) } };
    }),
  );

  server.registerTool(
    "record_experiment_results",
    {
      title: "Record experiment results",
      description:
        "Record the measured values and complete the experiment. Groundwork computes the verdict (validated, invalidated or inconclusive) from the targets and moves the hypothesis accordingly.",
      inputSchema: {
        id: itemId,
        primaryActual: z.number().describe("Measured value of the primary metric."),
        guardrailActuals: z.array(z.number()).max(5).default([]).describe("Measured value of each guardrail, in the experiment's order."),
        notes: z.string().trim().max(4000).default("").describe("What happened, in a few sentences."),
      },
    },
    write((s, state, c, a: { id: string; primaryActual: number; guardrailActuals: number[]; notes: string }) => {
      const e = state.experiments.find((x) => x.id === a.id);
      if (!e) throw new UserError(`No experiment with id ${a.id}.`);
      if (e.status === "completed") throw new UserError(`"${e.title}" already has results (${e.verdict}).`);
      const guardrails = e.guardrails ?? [];
      if (a.guardrailActuals.length !== guardrails.length) {
        throw new UserError(`"${e.title}" has ${guardrails.length} guardrail(s): ${guardrails.map((g) => g.name).join(", ") || "none"}. Give one value for each.`);
      }
      const [next, out] = apply(state, ops.recordResults(state, c, a.id, a.primaryActual, a.guardrailActuals, a.notes));
      const h = next.hypotheses.find((x) => x.id === e.hypothesisId);
      return {
        state: next,
        result: { verdict: out!.result.verdict, reason: out!.result.reason, experiment: s.summary("experiment", e), hypothesis: h && s.summary("hypothesis", h) },
      };
    }),
  );

  const requirementOf = (state: State, id: string) => {
    const r = state.requirements.find((x) => x.id === id);
    if (!r) throw new UserError(`No requirement with id ${id}.`);
    return r;
  };

  server.registerTool(
    "submit_requirement_for_approval",
    {
      title: "Submit requirement for approval",
      description: "Ask a person (by id from get_workspace members) to sign off a draft requirement.",
      inputSchema: { id: itemId, approverId: z.string().max(40) },
    },
    write((s, state, c, { id, approverId }: { id: string; approverId: string }) => {
      const r = requirementOf(state, id);
      const approver = s.config.people.find((m) => m.id === approverId);
      if (!approver) throw new UserError(`${approverId} isn't in groundwork/config.yml people. Add them there first.`);
      if (approver.role === "viewer") throw new UserError(`${approver.name} is a viewer, so they can't approve.`);
      if (r.status !== "draft") throw new UserError(`"${r.title}" is ${r.status}; only drafts can be submitted.`);
      const [next] = apply(state, ops.submitRequirement(state, c, id, approverId));
      return { state: next, result: { submitted: s.summary("requirement", requirementOf(next, id)), approver: approver.name } };
    }),
  );

  server.registerTool(
    "approve_requirement",
    {
      title: "Approve requirement",
      description:
        "Sign off a requirement that is awaiting your approval. Only the named approver can approve. If the approver signed off outside Groundwork (e.g. verbally), pass approvedBy and a note. Groundwork records who entered it.",
      inputSchema: {
        id: itemId,
        approvedBy: z
          .string()
          .max(40)
          .optional()
          .describe("Who approved it, when they did so outside Groundwork, e.g. verbally. A person id from get_workspace."),
        note: z.string().trim().max(300).optional().describe('How or where it was approved, e.g. "Approved by Maria in sprint planning".'),
        plannedFor: z
          .string()
          .max(40)
          .optional()
          .describe("Solution requirements: the planned product version it should ship in. Required once the product has planned versions (see get_workspace)."),
      },
      annotations: { destructiveHint: false },
    },
    write((s, state, c, { id, approvedBy, note, plannedFor }: { id: string; approvedBy?: string; note?: string; plannedFor?: string }) => {
      const r = requirementOf(state, id);
      const plan = s.planOnApproval(r, plannedFor);
      // After approval: plan it, and deal with what it replaces. With a planned version, the old requirements stay valid
      // until that version ships; without versions they become obsolete now, as before.
      const planned = (after: State): State => {
        let next = plan ? s.pinProduct(apply(after, ops.planRequirements(after, c, [id], plan))[0], id) : after;
        const old = (r.replaces ?? []).filter((x) => next.requirements.some((y) => y.id === x && canBeReplaced(y)));
        if (old.length && plan) {
          // With several replacements, it stays valid until the last of them ships.
          for (const x of old) {
            const o = requirementOf(next, x);
            const version = s.laterVersion(o, o.obsoletePlannedFor, plan);
            next = apply(next, ops.planObsolescence(next, c, [x], version, [...new Set([...(o.obsoletedBy ?? []), id])]))[0];
          }
        } else for (const x of old) next = apply(next, ops.obsoleteRequirement(next, c, x, [id]))[0];
        return next;
      };
      // Naming yourself isn't recording someone else's approval: the normal approver check applies.
      if (approvedBy && approvedBy !== s.actor.id) {
        const person = s.config.people.find((m) => m.id === approvedBy);
        if (!person) throw new UserError(`${approvedBy} isn't in groundwork/config.yml people. Add them there first.`);
        if (person.role === "viewer") throw new UserError(`${person.name} is a viewer, so they can't approve.`);
        if (r.status !== "draft" && r.status !== "awaiting-approval") {
          throw new UserError(`"${r.title}" is ${r.status}; only drafts and requirements awaiting approval can be approved.`);
        }
        if (r.approver && r.approver !== approvedBy) {
          const asked = s.config.people.find((m) => m.id === r.approver)?.name ?? r.approver;
          throw new UserError(
            `"${r.title}" is waiting for ${asked}, not ${person.name}. Record ${asked}'s approval, or ask ${asked} to send it back so it can be submitted to ${person.name}.`,
          );
        }
        const next = planned(apply(state, ops.approveRequirement(state, c, id, { approvedBy, note }))[0]);
        return { state: next, result: { approved: s.summary("requirement", requirementOf(next, id)), ...(plan ? { plannedFor: plan } : {}) } };
      }
      if (r.status !== "awaiting-approval") {
        const hint = r.status === "draft" ? " If someone approved it outside Groundwork, record it with approvedBy." : "";
        throw new UserError(`"${r.title}" is ${r.status}, not awaiting approval.${hint}`);
      }
      if (r.approver !== s.actor.id) {
        const name = s.config.people.find((m) => m.id === r.approver)?.name ?? r.approver ?? "someone else";
        throw new UserError(`"${r.title}" is waiting for ${name}, not you (${s.actor.id}). Set GROUNDWORK_USER or your email in config.yml people if that's wrong.`);
      }
      const next = planned(apply(state, ops.approveRequirement(state, c, id))[0]);
      return { state: next, result: { approved: s.summary("requirement", requirementOf(next, id)), ...(plan ? { plannedFor: plan } : {}) } };
    }),
  );

  server.registerTool(
    "plan_requirements",
    {
      title: "Plan requirements for a version",
      description:
        "Move approved solution requirements that haven't shipped to another planned version of their product, e.g. when work slips from 1.1 to 1.2. Requirements they replace move with them.",
      inputSchema: { ids: z.array(localId).min(1).max(50), version: z.string().trim().min(1).max(40) },
    },
    write((s, state, c, { ids, version }: { ids: string[]; version: string }) => {
      for (const id of ids) {
        const r = requirementOf(state, id);
        if (r.status !== "approved" && r.status !== "in-delivery") throw new UserError(`"${r.title}" is ${r.status}: approve it first, with plannedFor.`);
        if (r.releasedIn) throw new UserError(`"${r.title}" shipped in ${r.releasedIn}.`);
        s.checkPlanned(r, version);
      }
      let [next] = apply(state, ops.planRequirements(state, c, ids, version));
      for (const id of ids) next = s.pinProduct(next, id);
      // Requirements they replace become obsolete when the last of their replacements ships.
      for (const o of next.requirements.filter((x) => canBeReplaced(x) && !x.obsoletedIn && x.obsoletedBy?.some((y) => ids.includes(y)))) {
        const versions = (o.obsoletedBy ?? []).map((y) => next.requirements.find((z) => z.id === y)?.plannedFor).filter((v): v is string => Boolean(v));
        const last = versions.reduce<string | undefined>((a, v) => s.laterVersion(o, a, v), undefined);
        if (last && last !== o.obsoletePlannedFor) next = apply(next, ops.planObsolescence(next, c, [o.id], last))[0];
      }
      return { state: next, result: { planned: ids.map((id) => s.summary("requirement", requirementOf(next, id))), version } };
    }),
  );

  // -------------------------------------------------------------------------------------------
  // Releasing
  // -------------------------------------------------------------------------------------------

  const productArg = z.string().max(100).optional().describe("The product's id or title. Needed when there's more than one product.");
  const versionArg = z.string().trim().min(1).max(40);
  const reqIds = z.array(localId).max(100);
  /** The catalogue with one product replaced, for a report on the state after a change. */
  const withProduct = (s: Session, p: Product) => catalogueOf(s.config, s.catalogue.products.map((x) => (x.id === p.id ? p : x)));

  server.registerTool(
    "get_release",
    {
      title: "Get release",
      description:
        "For a planned version: the solution requirements planned to ship in it and the requirements planned to become obsolete in it. For a released version: its release report (introduced, made obsolete, stakeholder needs met, corrections).",
      inputSchema: { product: productArg, version: versionArg },
      annotations: { readOnlyHint: true },
    },
    read((s, { product, version }: { product?: string; version: string }) => {
      const p = s.targetProduct(product);
      const v = p.versions.find((x) => x.version === version);
      if (!v) throw new UserError(`${version} isn't a version of ${p.title}. Versions: ${p.versions.map((x) => x.version).join(", ") || "none"}.`);
      const requirements = s.loaded.items.requirements;
      if (v.status === "released") return { product: p.id, version, status: "released", report: releaseReport(requirements, s.catalogue, p, version) };
      const pending = pendingRelease(requirements, p, version, s.catalogue);
      const ref = (id: string) => ({ id, title: requirements.find((r) => r.id === id)?.title ?? id });
      return {
        product: p.id,
        version,
        status: "planned",
        planned: pending.planned.map((r) => ({ ...s.summary("requirement", r), tickets: (r as { tickets?: unknown[] }).tickets ?? [] })),
        obsoleteWhenReleased: {
          replaced: pending.replacedBy.map((r) => ({ ...s.summary("requirement", r), replacedBy: (r.obsoletedBy ?? []).map(ref) })),
          removals: pending.removals.map((r) => s.summary("requirement", r)),
        },
      };
    }),
  );

  server.registerTool(
    "release_version",
    {
      title: "Release version",
      description:
        "Release a planned version: `shipped` are the planned requirements that went out in it. Planned requirements not listed, and planned removals not confirmed in `removed`, move to `moveTo` (another planned version), which is required if there are any. Replaced requirements become obsolete once all their replacements have shipped. Show the user the list and get their agreement first.",
      inputSchema: { product: productArg, version: versionArg, shipped: reqIds, removed: reqIds.optional(), moveTo: versionArg.optional() },
    },
    write((s, state, c, a: { product?: string; version: string; shipped: string[]; removed?: string[]; moveTo?: string }) => {
      const p = s.targetProduct(a.product);
      const out = releaseVersion(state.requirements, s.catalogue, { product: p, version: a.version, shipped: a.shipped, removed: a.removed, moveTo: a.moveTo, actor: c.actor, now: c.now });
      const next = { ...state, requirements: out.requirements };
      return { state: next, products: [out.product], result: { released: `${p.title} ${a.version}`, report: releaseReport(out.requirements, withProduct(s, out.product), out.product, a.version) } };
    }),
  );

  server.registerTool(
    "release_requirements",
    {
      title: "Release requirements",
      description: "Record approved solution requirements as shipped in a version that's already released, e.g. for teams that ship continuously.",
      inputSchema: { product: productArg, version: versionArg, ids: reqIds.min(1) },
    },
    write((s, state, c, a: { product?: string; version: string; ids: string[] }) => {
      const p = s.targetProduct(a.product);
      const requirements = releaseRequirements(state.requirements, s.catalogue, { product: p, version: a.version, ids: a.ids, actor: c.actor, now: c.now });
      return { state: { ...state, requirements }, result: { report: releaseReport(requirements, s.catalogue, p, a.version) } };
    }),
  );

  server.registerTool(
    "correct_release",
    {
      title: "Correct release",
      description:
        "Correct a released version, e.g. a requirement recorded as shipped that didn't. Changes only what's listed; requirements taken out go back to `moveTo` (a planned version). The correction is recorded on the version with who, when and the reason, and shows in the release report. Ask the user for the reason.",
      inputSchema: {
        product: productArg,
        version: versionArg,
        reason: z.string().trim().min(1).max(500),
        addShipped: reqIds.optional(),
        removeShipped: reqIds.optional(),
        addObsolete: reqIds.optional(),
        removeObsolete: reqIds.optional(),
        moveTo: versionArg.optional(),
      },
    },
    write((s, state, c, a: { product?: string; version: string; reason: string; addShipped?: string[]; removeShipped?: string[]; addObsolete?: string[]; removeObsolete?: string[]; moveTo?: string }) => {
      const p = s.targetProduct(a.product);
      const out = correctRelease(state.requirements, s.catalogue, { ...a, product: p, actor: c.actor, now: c.now });
      return { state: { ...state, requirements: out.requirements }, products: [out.product], result: { report: releaseReport(out.requirements, withProduct(s, out.product), out.product, a.version) } };
    }),
  );

  server.registerTool(
    "send_back_requirement",
    {
      title: "Send requirement back",
      description: "Return a requirement awaiting your approval to draft, for changes. Only the named approver can do this.",
      inputSchema: { id: itemId },
    },
    write((s, state, c, { id }: { id: string }) => {
      const r = requirementOf(state, id);
      if (r.status !== "awaiting-approval") throw new UserError(`"${r.title}" is ${r.status}, not awaiting approval.`);
      if (r.approver !== s.actor.id) throw new UserError(`Only the approver can send "${r.title}" back.`);
      const [next] = apply(state, ops.sendBackRequirement(state, c, id));
      return { state: next, result: { sentBack: s.summary("requirement", requirementOf(next, id)) } };
    }),
  );

  server.registerTool(
    "obsolete_requirement",
    {
      title: "Make requirement obsolete",
      description:
        "Retire an approved requirement, optionally naming the requirements that replace it. To replace one, prefer adding the new requirement with replaces. With inVersion (a planned version of its product), it stays valid until that version is released; a requirement that has shipped needs inVersion.",
      inputSchema: {
        id: itemId,
        replacedBy: z.array(localId).max(20).optional(),
        inVersion: z.string().max(40).optional().describe("The planned version that removes it. It stays valid until then."),
      },
    },
    write((s, state, c, { id, replacedBy, inVersion }: { id: string; replacedBy?: string[]; inVersion?: string }) => {
      const r = requirementOf(state, id);
      s.check(state, "requirement", replacedBy, "replacedBy");
      if (inVersion) {
        if (!canBeReplaced(r)) throw new UserError(`Only approved requirements can be made obsolete; "${r.title}" is ${r.status}.`);
        s.checkPlanned(r, inVersion);
        const [next] = apply(state, ops.planObsolescence(state, c, [id], inVersion, replacedBy));
        return { state: next, result: { obsoleteIn: inVersion, requirement: s.summary("requirement", requirementOf(next, id)) } };
      }
      if (r.releasedIn) throw new UserError(`"${r.title}" shipped in ${r.releasedIn}: pass inVersion, the version that removes it.`);
      if (r.status !== "approved") throw new UserError(`Only approved requirements can be made obsolete; "${r.title}" is ${r.status}.`);
      const [next] = apply(state, ops.obsoleteRequirement(state, c, id, replacedBy));
      return { state: next, result: { obsolete: s.summary("requirement", requirementOf(next, id)) } };
    }),
  );

  server.registerTool(
    "delete_item",
    {
      title: "Delete item",
      description:
        "Delete an item's file. Links to it are removed from other items; deleting a hypothesis also deletes its experiments. Confirm with the user first.",
      inputSchema: { id: itemId },
      annotations: { destructiveHint: true },
    },
    write((_s, state, _c, { id }: { id: string }) => {
      const hit = find(state, id);
      if (!hit) throw new UserError(`No item with id ${id}.`);
      if (hit.kind === "requirement") {
        const orphaned = fulfilledBy(id, state.requirements).filter((r) => r.stakeholderIds?.length === 1);
        if (orphaned.length) {
          throw new UserError(
            `${orphaned.map((r) => `${r.id} "${r.title}"`).join(", ")} only fulfil${orphaned.length === 1 ? "s" : ""} "${hit.item.title}". Link ${orphaned.length === 1 ? "it" : "them"} to another stakeholder requirement or delete ${orphaned.length === 1 ? "it" : "them"} first.`,
          );
        }
      }
      const change =
        hit.kind === "insight"
          ? ops.deleteInsight(state, id)
          : hit.kind === "hypothesis"
            ? ops.deleteHypothesis(state, id)
            : hit.kind === "experiment"
              ? ops.deleteExperiment(state, id)
              : hit.kind === "finding"
                ? ops.deleteFinding(state, id)
                : ops.deleteRequirement(state, id);
      const [next] = apply(state, change);
      const alsoDeleted = hit.kind === "hypothesis" ? state.experiments.filter((e) => e.hypothesisId === id).map((e) => e.id) : [];
      return { state: next, result: { deleted: { kind: hit.kind, id, title: hit.item.title }, ...(alsoDeleted.length ? { alsoDeletedExperiments: alsoDeleted } : {}) } };
    }),
  );

  return server;
}
