import type { Collections } from "../core/collections";
import * as ops from "../core/ops";
import { kindOf } from "../core/requirements";
import { productOf, type Catalogue } from "./catalogue";
import type { Product } from "./products";
import { pendingRelease, ReleaseError, releaseRequirements, releaseVersion } from "./release";

/**
 * Recording an existing product's behaviour as the as-is baseline: inferred hypotheses and approved requirements,
 * shipped in a baseline version, in one change. The modernized product's requirements later replace them.
 */

export type NewHypothesisBase = Omit<ops.NewHypothesis, "status" | "origin">;
export type BaselineRequirement = Omit<ops.DirectRequirement, "status" | "origin" | "kind" | "product">;

export interface BaselineInput {
  /** Resolved by the caller. */
  product: Product;
  version: string;
  /** Person id, already checked by the caller. */
  approvedBy: string;
  /** Approval note; default "Recorded as the as-is baseline". */
  note?: string;
  /** Commit or tag, appended to each originNote. */
  sourceRef?: string;
  /** Area id, the default for every item without its own productArea. */
  area?: string;
  hypotheses: (NewHypothesisBase & { key: string })[];
  stakeholder: (BaselineRequirement & { key: string; hypothesisKeys?: string[] })[];
  solution: (BaselineRequirement & { stakeholderKeys?: string[]; hypothesisKeys?: string[] })[];
}

export interface BaselineResult {
  state: Collections;
  product: Product;
  created: { hypotheses: Record<string, string>; stakeholder: Record<string, string>; solution: string[] };
  warnings: string[];
}

const apply = <R>(state: Collections, change: ops.Change<R>): [Collections, R] => [{ ...state, ...change.next }, change.result];

function resolve(keys: string[] | undefined, ids: Record<string, string>): string[] {
  return (keys ?? []).map((k) => {
    if (!(k in ids)) throw new ReleaseError(`Unknown key ${k}.`);
    return ids[k];
  });
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function recordBaseline(state: Collections, catalogue: Catalogue, input: BaselineInput, c: ops.Ctx): BaselineResult {
  const { version, approvedBy } = input;
  const p0 = input.product;
  const originNote = `Reverse-engineered from the existing product${input.sourceRef ? ` @ ${input.sourceRef}` : ""}`;
  const approval = {
    status: "approved" as const,
    origin: "existing-product" as const,
    approvedBy,
    approvedAt: c.now,
    approvalNote: input.note ?? "Recorded as the as-is baseline",
    ...(c.actor !== approvedBy ? { recordedBy: c.actor } : {}),
    product: p0.id,
  };

  // Check every key before changing anything.
  const unique = (items: { key: string }[], list: string) => {
    const seen = new Set<string>();
    for (const { key } of items) {
      if (seen.has(key)) throw new ReleaseError(`Duplicate key "${key}" in ${list}.`);
      seen.add(key);
    }
  };
  unique(input.hypotheses, "hypotheses");
  unique(input.stakeholder, "stakeholder");
  const hKeys = Object.fromEntries(input.hypotheses.map((h) => [h.key, h.key]));
  const sKeys = Object.fromEntries(input.stakeholder.map((s) => [s.key, s.key]));
  for (const s of input.stakeholder) resolve(s.hypothesisKeys, hKeys);
  for (const s of input.solution) {
    resolve(s.hypothesisKeys, hKeys);
    resolve(s.stakeholderKeys, sKeys);
  }

  // The version: missing ones become the oldest; a planned one may hold only the baseline; a released one only earlier baselines.
  const product: Product = p0.versions.some((v) => v.version === version) ? p0 : { ...p0, versions: [{ version, status: "planned" }, ...p0.versions] };
  const cat: Catalogue = {
    ...catalogue,
    products: catalogue.products.some((x) => x.id === product.id) ? catalogue.products.map((x) => (x.id === product.id ? product : x)) : [...catalogue.products, product],
  };
  const v = product.versions.find((x) => x.version === version)!;
  if (v.status === "planned") {
    const pending = pendingRelease(state.requirements, product, version, cat);
    const other = [...pending.planned, ...pending.removals, ...pending.replacedBy];
    if (other.length) throw new ReleaseError(`${product.title} ${version} has other work planned: ${other.map((r) => r.id).join(", ")}. Record the baseline in its own version.`);
  } else {
    const other = state.requirements.filter((r) => r.releasedIn === version && kindOf(r) === "solution" && productOf(cat, r)?.id === product.id && r.origin !== "existing-product");
    if (other.length) throw new ReleaseError(`${product.title} ${version} already shipped requirements that aren't part of a baseline: ${other.map((r) => r.id).join(", ")}.`);
  }

  const existing = state.requirements;
  let s = state;
  const created: BaselineResult["created"] = { hypotheses: {}, stakeholder: {}, solution: [] };

  if (input.hypotheses.length) {
    const items = input.hypotheses.map(({ key: _key, ...h }) => {
      void _key;
      return { ...h, status: "validated" as const, origin: "inferred" as const, originNote: h.originNote ?? originNote, productArea: h.productArea ?? input.area };
    });
    const [next, hs] = apply(s, ops.addHypotheses(s, c, items));
    s = next;
    input.hypotheses.forEach((h, i) => (created.hypotheses[h.key] = hs[i].id));
  }

  const add = (item: BaselineRequirement, kind: "stakeholder" | "solution", links: Partial<ops.DirectRequirement>) => {
    const [next, r] = apply(
      s,
      ops.createRequirement(s, c, { ...item, ...links, ...approval, kind, originNote: item.originNote ?? originNote, productArea: item.productArea ?? input.area }),
    );
    s = next;
    return r.id;
  };
  const withIds = (given: string[] | undefined, more: string[]) => (given?.length || more.length ? [...new Set([...(given ?? []), ...more])] : undefined);

  for (const { key, hypothesisKeys, ...item } of input.stakeholder) {
    const hypothesisIds = withIds(item.hypothesisIds, resolve(hypothesisKeys, created.hypotheses));
    created.stakeholder[key] = add(item, "stakeholder", hypothesisIds ? { hypothesisIds } : {});
  }
  for (const { stakeholderKeys, hypothesisKeys, ...item } of input.solution) {
    const stakeholderIds = withIds(item.stakeholderIds, resolve(stakeholderKeys, created.stakeholder));
    const hypothesisIds = withIds(item.hypothesisIds, resolve(hypothesisKeys, created.hypotheses));
    created.solution.push(add(item, "solution", { plannedFor: version, ...(stakeholderIds ? { stakeholderIds } : {}), ...(hypothesisIds ? { hypothesisIds } : {}) }));
  }

  const warnings: string[] = [];
  for (const id of [...Object.values(created.stakeholder), ...created.solution]) {
    const r = s.requirements.find((x) => x.id === id)!;
    const match = existing.find((x) => same(x.title, r.title) && x.productArea === r.productArea && productOf(cat, x)?.id === product.id);
    if (match) warnings.push(`"${r.title}" matches ${match.id} already in the baseline area`);
  }

  let released: Product = product;
  if (v.status === "planned") {
    const out = releaseVersion(s.requirements, cat, { product, version, shipped: created.solution, actor: c.actor, now: c.now });
    s = { ...s, requirements: out.requirements };
    released = out.product;
  } else if (created.solution.length) {
    s = { ...s, requirements: releaseRequirements(s.requirements, cat, { product, version, ids: created.solution, actor: c.actor, now: c.now }) };
  }
  return { state: s, product: released, created, warnings };
}
