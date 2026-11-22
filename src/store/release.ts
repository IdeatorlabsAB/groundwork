import { kindOf } from "../core/requirements";
import type { Requirement } from "../core/types";
import { plannedVersions, productOf, type Catalogue } from "./catalogue";
import type { Product, ProductVersion } from "./products";

/**
 * Releasing product versions. Only solution requirements belong to releases. A version is released once, as a
 * deliberate step; after that it changes only through a recorded correction.
 */

export class ReleaseError extends Error {}

export interface Correction {
  at: string;
  by: string;
  reason: string;
  shipped: { added: string[]; removed: string[] };
  obsolete: { added: string[]; removed: string[] };
  movedTo?: string;
}

/** The later of two versions in the product's release order (its list order). */
export function laterVersion(p: Product | undefined, a: string | undefined, b: string): string {
  if (!a) return b;
  const order = p?.versions.map((v) => v.version) ?? [];
  return order.indexOf(a) > order.indexOf(b) ? a : b;
}

const isActive = (r: Requirement) => r.status === "approved" || r.status === "in-delivery";
const inProduct = (c: Catalogue, p: Product) => (r: Requirement) => kindOf(r) === "solution" && productOf(c, r)?.id === p.id;

function versionOf(p: Product, version: string): ProductVersion {
  const v = p.versions.find((x) => x.version === version);
  if (!v) throw new ReleaseError(`${version} isn't a version of ${p.title}.`);
  return v;
}

function withVersion(p: Product, version: string, change: (v: ProductVersion) => ProductVersion): Product {
  return { ...p, versions: p.versions.map((v) => (v.version === version ? change(v) : v)) };
}

function checkMoveTo(p: Product, version: string, moveTo: string | undefined, what: string): string {
  const planned = plannedVersions(p).filter((v) => v !== version);
  if (!moveTo || !planned.includes(moveTo)) {
    throw new ReleaseError(`${what} Pass moveTo, another planned version of ${p.title}: ${planned.join(", ") || "none (add one with add_product_versions)"}.`);
  }
  return moveTo;
}

const obsolete = (r: Requirement, version: string, now: string, actor: string): Requirement => {
  const { obsoletePlannedFor: _planned, ...rest } = r;
  void _planned;
  return { ...rest, status: "obsolete", obsoletedIn: version, obsoletedAt: now, madeObsoleteBy: actor };
};

/** What's planned for a version: requirements to ship, and requirements to become obsolete (replaced, or removed). */
export function pendingRelease(requirements: Requirement[], product: Product, version: string, catalogue: Catalogue) {
  const mine = requirements.filter(inProduct(catalogue, product));
  const planned = mine.filter((r) => isActive(r) && r.plannedFor === version && !r.releasedIn);
  const obsoleting = mine.filter((r) => isActive(r) && r.obsoletePlannedFor === version && !r.obsoletedIn);
  return { planned, replacedBy: obsoleting.filter((r) => r.obsoletedBy?.length), removals: obsoleting.filter((r) => !r.obsoletedBy?.length) };
}

/**
 * A replaced requirement becomes obsolete in `version` once all its replacements have shipped; until then its
 * obsolescence follows the latest planned version among the replacements still to ship.
 */
function settleReplaced(requirements: Requirement[], product: Product, version: string, affected: (r: Requirement) => boolean, now: string, actor: string) {
  return requirements.map((r) => {
    if (!isActive(r) || r.obsoletedIn || !r.obsoletedBy?.length || !affected(r)) return r;
    const reps = r.obsoletedBy.map((id) => requirements.find((x) => x.id === id)).filter((x): x is Requirement => Boolean(x));
    if (!reps.length) return r;
    if (reps.every((x) => x.releasedIn)) return obsolete(r, version, now, actor);
    const pending = reps.filter((x) => !x.releasedIn && x.plannedFor).map((x) => x.plannedFor!);
    const last = pending.reduce<string | undefined>((a, v) => laterVersion(product, a, v), undefined);
    return last && last !== r.obsoletePlannedFor ? { ...r, obsoletePlannedFor: last } : r;
  });
}

export interface ReleaseInput {
  product: Product;
  version: string;
  shipped: string[];
  removed?: string[];
  moveTo?: string;
  actor: string;
  now: string;
}

export function releaseVersion(requirements: Requirement[], catalogue: Catalogue, input: ReleaseInput): { requirements: Requirement[]; product: Product } {
  const { product: p, version, actor, now } = input;
  const v = versionOf(p, version);
  if (v.status === "released") {
    throw new ReleaseError(
      `${p.title} ${version} is already released. To fix it, use correct_release; to add requirements that shipped in it later, use release_requirements.`,
    );
  }
  const { planned, removals } = pendingRelease(requirements, p, version, catalogue);
  const shipped = new Set(input.shipped);
  const removed = new Set(input.removed ?? []);
  for (const id of shipped) if (!planned.some((r) => r.id === id)) throw new ReleaseError(`${id} isn't planned for ${version}.`);
  for (const id of removed) if (!removals.some((r) => r.id === id)) throw new ReleaseError(`${id} isn't planned to become obsolete in ${version}.`);
  const leftovers = planned.filter((r) => !shipped.has(r.id));
  const keep = removals.filter((r) => !removed.has(r.id));
  let moveTo: string | undefined;
  if (leftovers.length || keep.length) {
    const names = [...leftovers.map((r) => `${r.id} (planned)`), ...keep.map((r) => `${r.id} (to become obsolete)`)].join(", ");
    moveTo = checkMoveTo(p, version, input.moveTo, `Not in ${version}: ${names}.`);
  }
  let out = requirements.map((r) => {
    if (shipped.has(r.id)) return { ...r, releasedIn: version, releasedAt: now, releasedBy: actor };
    if (leftovers.some((x) => x.id === r.id)) return { ...r, plannedFor: moveTo };
    if (removed.has(r.id)) return obsolete(r, version, now, actor);
    if (keep.some((x) => x.id === r.id)) return { ...r, obsoletePlannedFor: moveTo };
    return r;
  });
  out = settleReplaced(out, p, version, (r) => r.obsoletePlannedFor === version || r.obsoletedBy!.some((id) => shipped.has(id) || leftovers.some((x) => x.id === id)), now, actor);
  return { requirements: out, product: withVersion(p, version, (x) => ({ ...x, status: "released", releasedAt: now, releasedBy: actor })) };
}

/** Requirements that shipped in an already released version, e.g. for teams that ship continuously. */
export function releaseRequirements(
  requirements: Requirement[],
  catalogue: Catalogue,
  input: { product: Product; version: string; ids: string[]; actor: string; now: string },
): Requirement[] {
  const { product: p, version, ids, actor, now } = input;
  if (versionOf(p, version).status !== "released") throw new ReleaseError(`${p.title} ${version} is not released yet. Release it with release_version.`);
  checkShippable(requirements, catalogue, p, ids);
  const out = requirements.map((r) => (ids.includes(r.id) ? { ...r, releasedIn: version, releasedAt: now, releasedBy: actor } : r));
  return settleReplaced(out, p, version, (r) => r.obsoletedBy!.some((id) => ids.includes(id)), now, actor);
}

function checkShippable(requirements: Requirement[], catalogue: Catalogue, p: Product, ids: string[]) {
  for (const id of ids) {
    const r = requirements.find((x) => x.id === id);
    if (!r) throw new ReleaseError(`No requirement with id ${id}.`);
    if (!inProduct(catalogue, p)(r)) throw new ReleaseError(`${id} isn't a solution requirement of ${p.title}.`);
    if (!isActive(r)) throw new ReleaseError(`${id} is ${r.status}; only approved requirements ship.`);
    if (r.releasedIn) throw new ReleaseError(`${id} already shipped in ${r.releasedIn}.`);
  }
}

export interface CorrectionInput {
  product: Product;
  version: string;
  reason: string;
  addShipped?: string[];
  removeShipped?: string[];
  addObsolete?: string[];
  removeObsolete?: string[];
  moveTo?: string;
  actor: string;
  now: string;
}

/**
 * Correct a released version. It changes only what it lists (no cascading), and is recorded on the version with
 * who, when and why.
 */
export function correctRelease(requirements: Requirement[], catalogue: Catalogue, input: CorrectionInput): { requirements: Requirement[]; product: Product } {
  const { product: p, version, actor, now } = input;
  const reason = input.reason?.trim();
  if (!reason) throw new ReleaseError("A correction needs a reason.");
  if (versionOf(p, version).status !== "released") throw new ReleaseError(`${p.title} ${version} isn't released yet, so there's nothing to correct.`);
  const addShipped = input.addShipped ?? [];
  const removeShipped = input.removeShipped ?? [];
  const addObsolete = input.addObsolete ?? [];
  const removeObsolete = input.removeObsolete ?? [];
  if (![addShipped, removeShipped, addObsolete, removeObsolete].some((l) => l.length)) throw new ReleaseError("The correction doesn't change anything.");
  const find = (id: string) => {
    const r = requirements.find((x) => x.id === id);
    if (!r) throw new ReleaseError(`No requirement with id ${id}.`);
    return r;
  };
  checkShippable(requirements, catalogue, p, addShipped);
  for (const id of removeShipped) if (find(id).releasedIn !== version) throw new ReleaseError(`${id} didn't ship in ${version}.`);
  for (const id of removeObsolete) if (find(id).obsoletedIn !== version) throw new ReleaseError(`${id} wasn't made obsolete in ${version}.`);
  for (const id of addObsolete) if (!isActive(find(id))) throw new ReleaseError(`${id} is ${find(id).status}; only approved requirements can be made obsolete.`);
  const moveTo = removeShipped.length || removeObsolete.length ? checkMoveTo(p, version, input.moveTo, "Requirements taken out of a release go back to a planned version.") : undefined;

  const out = requirements.map((r) => {
    if (addShipped.includes(r.id)) return { ...r, releasedIn: version, releasedAt: now, releasedBy: actor };
    if (removeShipped.includes(r.id)) {
      const { releasedIn: _a, releasedAt: _b, releasedBy: _c, ...rest } = r;
      void _a, void _b, void _c;
      return { ...rest, plannedFor: moveTo };
    }
    if (addObsolete.includes(r.id)) return obsolete(r, version, now, actor);
    if (removeObsolete.includes(r.id)) {
      const { obsoletedIn: _a, obsoletedAt: _b, madeObsoleteBy: _c, ...rest } = r;
      void _a, void _b, void _c;
      return { ...rest, status: "approved" as const, obsoletePlannedFor: moveTo };
    }
    return r;
  });
  const correction: Correction = {
    at: now,
    by: actor,
    reason,
    shipped: { added: addShipped, removed: removeShipped },
    obsolete: { added: addObsolete, removed: removeObsolete },
    ...(moveTo ? { movedTo: moveTo } : {}),
  };
  return { requirements: out, product: withVersion(p, version, (v) => ({ ...v, corrections: [...(v.corrections ?? []), correction] })) };
}
