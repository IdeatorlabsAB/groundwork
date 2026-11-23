import { kindOf, ticketsOf } from "../core/requirements";
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
  // Readiness from ticket status: ready only when it has tickets and all are done. No tickets is never "ready".
  const noTickets = planned.filter((r) => !ticketsOf(r).length);
  const ready = planned.filter((r) => ticketsOf(r).length && ticketsOf(r).every((t) => t.done));
  const notReady = planned.filter((r) => ticketsOf(r).length && !ticketsOf(r).every((t) => t.done));
  return { planned, ready, notReady, noTickets, replacedBy: obsoleting.filter((r) => r.obsoletedBy?.length), removals: obsoleting.filter((r) => !r.obsoletedBy?.length) };
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
  const uniq = (l?: string[]) => [...new Set(l ?? [])];
  const addShipped = uniq(input.addShipped);
  const removeShipped = uniq(input.removeShipped);
  const addObsolete = uniq(input.addObsolete);
  const removeObsolete = uniq(input.removeObsolete);
  // One change per requirement, so the record says exactly what was done.
  const all = [...addShipped, ...removeShipped, ...addObsolete, ...removeObsolete];
  const twice = all.filter((id, i) => all.indexOf(id) !== i);
  if (twice.length) throw new ReleaseError(`${[...new Set(twice)].join(", ")} is listed more than once in the correction. Correct one thing per requirement.`);
  if (![addShipped, removeShipped, addObsolete, removeObsolete].some((l) => l.length)) throw new ReleaseError("The correction doesn't change anything.");
  const find = (id: string) => {
    const r = requirements.find((x) => x.id === id);
    if (!r) throw new ReleaseError(`No requirement with id ${id}.`);
    return r;
  };
  checkShippable(requirements, catalogue, p, addShipped);
  for (const id of removeShipped) if (find(id).releasedIn !== version) throw new ReleaseError(`${id} didn't ship in ${version}.`);
  for (const id of removeObsolete) if (find(id).obsoletedIn !== version) throw new ReleaseError(`${id} wasn't made obsolete in ${version}.`);
  for (const id of addObsolete) {
    const r = find(id);
    if (!inProduct(catalogue, p)(r)) throw new ReleaseError(`${id} isn't a solution requirement of ${p.title}.`);
    if (!isActive(r)) throw new ReleaseError(`${id} is ${r.status}; only approved requirements can be made obsolete.`);
  }
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

export interface StakeholderProgress {
  id: string;
  title: string;
  /** Solution requirements fulfilling it that have shipped. */
  released: number;
  /** Solution requirements fulfilling it: the current ones, plus ones that shipped and were later made obsolete. */
  total: number;
  /** The version in which the last of its current solution requirements shipped, once all have. */
  fullyMetIn?: string;
}

/** A stakeholder requirement's progress, derived from the solution requirements that fulfil it (never stored). */
export function stakeholderProgress(requirements: Requirement[], stakeholderId: string, catalogue: Catalogue, asOf?: { product: Product; version: string }): StakeholderProgress {
  const s = requirements.find((r) => r.id === stakeholderId);
  const fulfilling = requirements.filter((r) => kindOf(r) === "solution" && r.stakeholderIds?.includes(stakeholderId));
  if (asOf) return progressAsOf(stakeholderId, s, fulfilling, asOf);
  const counted = fulfilling.filter((r) => r.status !== "obsolete" || r.releasedIn);
  const released = counted.filter((r) => r.releasedIn);
  const current = fulfilling.filter((r) => r.status !== "obsolete");
  let fullyMetIn: string | undefined;
  if (current.length && current.every((r) => r.releasedIn)) {
    for (const r of current) fullyMetIn = laterVersion(productOf(catalogue, r), fullyMetIn, r.releasedIn!);
  }
  return { id: stakeholderId, title: s?.title ?? stakeholderId, released: released.length, total: counted.length, ...(fullyMetIn ? { fullyMetIn } : {}) };
}

/**
 * Progress as it stood when a version was released, by time: requirements approved after the release, drafts, and
 * releases after it don't count. So an old report reads the same later, even if versions were released out of order.
 */
function progressAsOf(id: string, s: Requirement | undefined, fulfilling: Requirement[], asOf: { product: Product; version: string }): StakeholderProgress {
  const cutoff = asOf.product.versions.find((v) => v.version === asOf.version)?.releasedAt;
  const by = (t: string | undefined) => !cutoff || !t || t <= cutoff;
  const releasedAsOf = (r: Requirement) => Boolean(r.releasedIn) && (r.releasedIn === asOf.version || (by(r.releasedAt) && Boolean(r.releasedAt)) || !cutoff);
  const existedAsOf = (r: Requirement) =>
    releasedAsOf(r) || ((r.status === "approved" || r.status === "in-delivery" || r.status === "obsolete") && by(r.approvedAt) && !(r.obsoletedAt && cutoff && r.obsoletedAt <= cutoff));
  const counted = fulfilling.filter(existedAsOf);
  const released = counted.filter(releasedAsOf);
  const metHere = counted.length > 0 && released.length === counted.length && counted.some((r) => r.releasedIn === asOf.version);
  return {
    id,
    title: s?.title ?? id,
    released: released.length,
    total: counted.length,
    ...(metHere ? { fullyMetIn: asOf.version } : {}),
  };
}

export interface ReleaseReport {
  product: { id: string; title: string };
  version: ProductVersion;
  introduced: { id: string; title: string; story: string; tickets: unknown[]; stakeholders: { id: string; title: string }[]; releasedAt?: string; releasedBy?: string }[];
  madeObsolete: { id: string; title: string; replacedBy: { id: string; title: string }[] }[];
  stakeholders: (StakeholderProgress & { inThisVersion: "fully met" | "partly met" })[];
  corrections: Correction[];
}

export function releaseReport(requirements: Requirement[], catalogue: Catalogue, product: Product, version: string): ReleaseReport {
  const v = versionOf(product, version);
  const mine = requirements.filter(inProduct(catalogue, product));
  const ref = (id: string) => ({ id, title: requirements.find((r) => r.id === id)?.title ?? id });
  const introduced = mine
    .filter((r) => r.releasedIn === version)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      title: r.title,
      story: r.story,
      // The tickets as they were when the version was released; later links (e.g. a fix) aren't part of it.
      tickets: ticketsOf(r).filter((t) => !v.releasedAt || t.linkedAt <= v.releasedAt) as unknown[],
      stakeholders: (r.stakeholderIds ?? []).map(ref),
      ...(r.releasedAt ? { releasedAt: r.releasedAt } : {}),
      ...(r.releasedBy ? { releasedBy: r.releasedBy } : {}),
    }));
  const madeObsolete = mine
    .filter((r) => r.obsoletedIn === version)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({ id: r.id, title: r.title, replacedBy: (r.obsoletedBy ?? []).map(ref) }));
  const stakeholderIds = [...new Set(introduced.flatMap((r) => r.stakeholders.map((s) => s.id)))].sort();
  const stakeholders = stakeholderIds.map((id) => {
    const p = stakeholderProgress(requirements, id, catalogue, { product, version });
    return { ...p, inThisVersion: p.fullyMetIn === version ? ("fully met" as const) : ("partly met" as const) };
  });
  return { product: { id: product.id, title: product.title }, version: v, introduced, madeObsolete, stakeholders, corrections: v.corrections ?? [] };
}

/** The release report as Markdown, e.g. for technical documentation. */
export function renderReleaseReport(r: ReleaseReport): string {
  const day = (iso?: string) => (iso ? iso.slice(0, 10) : "not released yet");
  const lines = [`# ${r.product.title} ${r.version.version}: release report`, ""];
  lines.push(r.version.status === "released" ? `Released ${day(r.version.releasedAt)} by ${r.version.releasedBy ?? "unknown"}. Product ${r.product.id}.` : "This version isn't released yet.", "");
  lines.push("## Introduced", "");
  if (!r.introduced.length) lines.push("Nothing.");
  for (const x of r.introduced) {
    const late = x.releasedAt && r.version.releasedAt && x.releasedAt > r.version.releasedAt ? ` (added ${day(x.releasedAt)} by ${x.releasedBy ?? "unknown"})` : "";
    lines.push(`- **${x.id}** ${x.title}${late}: ${x.story}`);
    if (x.stakeholders.length) lines.push(`  - Meets: ${x.stakeholders.map((s) => `${s.id} ${s.title}`).join("; ")}`);
    const tickets = x.tickets as { tracker: string; key: string }[];
    if (tickets.length) {
      const byTracker = new Map<string, string[]>();
      for (const t of tickets) byTracker.set(t.tracker, [...(byTracker.get(t.tracker) ?? []), t.key]);
      lines.push(`  - Tickets: ${[...byTracker].map(([tracker, keys]) => `${tracker} ${keys.join(", ")}`).join("; ")}`);
    }
  }
  lines.push("", "## Made obsolete", "");
  if (!r.madeObsolete.length) lines.push("Nothing.");
  for (const x of r.madeObsolete) {
    lines.push(`- **${x.id}** ${x.title}${x.replacedBy.length ? `, replaced by ${x.replacedBy.map((s) => `${s.id} ${s.title}`).join("; ")}` : ", removed"}`);
  }
  lines.push("", "## Stakeholder requirements", "");
  if (!r.stakeholders.length) lines.push("None affected.");
  for (const s of r.stakeholders) {
    lines.push(`- **${s.id}** ${s.title}: ${s.inThisVersion} (${s.released} of ${s.total} solution requirements released)`);
  }
  if (r.corrections.length) {
    lines.push("", "## Corrections", "");
    for (const c of r.corrections) {
      const parts = [
        c.shipped.added.length && `added to shipped: ${c.shipped.added.join(", ")}`,
        c.shipped.removed.length && `taken out of shipped: ${c.shipped.removed.join(", ")}`,
        c.obsolete.added.length && `made obsolete: ${c.obsolete.added.join(", ")}`,
        c.obsolete.removed.length && `no longer obsolete: ${c.obsolete.removed.join(", ")}`,
        c.movedTo && `moved to ${c.movedTo}`,
      ].filter(Boolean);
      lines.push(`- ${day(c.at)}, ${c.by}: ${parts.join("; ")}. Reason: ${c.reason}`);
    }
  }
  return lines.join("\n") + "\n";
}
