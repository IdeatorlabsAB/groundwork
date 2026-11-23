import { describe, expect, it } from "vitest";
import type { Requirement } from "../src/core/types";
import { catalogueOf } from "../src/store/catalogue";
import { configSchema } from "../src/store/config";
import type { Product } from "../src/store/products";
import { correctRelease, pendingRelease, ReleaseError, releaseReport, releaseRequirements, releaseVersion, renderReleaseReport, stakeholderProgress } from "../src/store/release";

const NOW = "2026-12-15T10:00:00.000Z";
const product = (versions: Product["versions"] = ["1.0", "1.1", "1.2"].map((version) => ({ version, status: "planned" as const }))): Product => ({
  id: "PRD-0001",
  title: "Clinicare Web Application",
  areas: [],
  versions,
});
const cat = (p: Product) => catalogueOf(configSchema.parse({ name: "Clinicare" }), [p]);
const req = (id: string, extra: Partial<Requirement> = {}): Requirement => ({
  id,
  title: id,
  kind: "solution",
  story: `The system shall do ${id}.`,
  stakeholderIds: ["S"],
  product: "PRD-0001",
  acceptanceCriteria: ["a"],
  priority: "must",
  status: "approved",
  findingIds: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});
const by = (rs: Requirement[], id: string) => rs.find((r) => r.id === id)!;
const release = (rs: Requirement[], p: Product, input: { version: string; shipped: string[]; removed?: string[]; moveTo?: string }) =>
  releaseVersion(rs, cat(p), { product: p, actor: "sam", now: NOW, ...input });

describe("releasing a version", () => {
  it("ships what's listed, and requires a version for the rest", () => {
    const p = product();
    const rs = [req("A", { plannedFor: "1.0" }), req("B", { plannedFor: "1.0" })];
    expect(() => release(rs, p, { version: "1.0", shipped: ["A"] })).toThrow(/B.*moveTo/s);
    const out = release(rs, p, { version: "1.0", shipped: ["A"], moveTo: "1.1" });
    expect(by(out.requirements, "A")).toMatchObject({ releasedIn: "1.0", releasedAt: NOW, releasedBy: "sam" });
    expect(by(out.requirements, "B")).toMatchObject({ plannedFor: "1.1" });
    expect(by(out.requirements, "B").releasedIn).toBeUndefined();
    expect(out.product.versions[0]).toMatchObject({ version: "1.0", status: "released", releasedAt: NOW, releasedBy: "sam" });
  });

  it("makes a replaced requirement obsolete when its replacement ships", () => {
    const p = product();
    const rs = [req("O", { plannedFor: "0.9", releasedIn: undefined, obsoletePlannedFor: "1.0", obsoletedBy: ["R"] }), req("R", { plannedFor: "1.0", replaces: ["O"] })];
    rs[0].plannedFor = undefined;
    const out = release(rs, p, { version: "1.0", shipped: ["R"] });
    expect(by(out.requirements, "O")).toMatchObject({ status: "obsolete", obsoletedIn: "1.0", obsoletedAt: NOW, madeObsoleteBy: "sam" });
  });

  it("keeps a requirement valid until the last of its replacements ships", () => {
    const p = product();
    const rs = [
      req("O", { obsoletePlannedFor: "1.1", obsoletedBy: ["R1", "R2"] }),
      req("R1", { plannedFor: "1.0", replaces: ["O"] }),
      req("R2", { plannedFor: "1.1", replaces: ["O"] }),
    ];
    const out = release(rs, p, { version: "1.0", shipped: ["R1"] });
    expect(by(out.requirements, "O")).toMatchObject({ status: "approved", obsoletePlannedFor: "1.1" });
  });

  it("needs planned removals confirmed, or moved", () => {
    const p = product();
    const rs = [req("X", { releasedIn: undefined, obsoletePlannedFor: "1.0" })];
    expect(() => release(rs, p, { version: "1.0", shipped: [] })).toThrow(/X.*moveTo/s);
    expect(by(release(rs, p, { version: "1.0", shipped: [], removed: ["X"] }).requirements, "X")).toMatchObject({ status: "obsolete", obsoletedIn: "1.0" });
    expect(by(release(rs, p, { version: "1.0", shipped: [], moveTo: "1.1" }).requirements, "X")).toMatchObject({ status: "approved", obsoletePlannedFor: "1.1" });
  });

  it("refuses ids that aren't planned, and moveTo that isn't another planned version", () => {
    const p = product();
    const rs = [req("A", { plannedFor: "1.0" }), req("B", { plannedFor: "1.1" })];
    expect(() => release(rs, p, { version: "1.0", shipped: ["B"] })).toThrow(/B isn't planned for 1.0/);
    expect(() => release([...rs, req("C", { plannedFor: "1.0" })], p, { version: "1.0", shipped: ["A"], moveTo: "1.0" })).toThrow(ReleaseError);
    expect(() => release([...rs, req("C", { plannedFor: "1.0" })], p, { version: "1.0", shipped: ["A"], moveTo: "9.9" })).toThrow(/another planned version/);
  });

  it("refuses releasing a version twice", () => {
    const p = product();
    const rs = [req("A", { plannedFor: "1.0" })];
    const out = release(rs, p, { version: "1.0", shipped: ["A"] });
    expect(() => release(out.requirements, out.product, { version: "1.0", shipped: [] })).toThrow(/already released.*correct_release.*release_requirements/s);
  });
});

describe("after a release", () => {
  const released = () => {
    const p = product();
    const rs = [req("A", { plannedFor: "1.0" }), req("C", { plannedFor: "1.1" })];
    return release(rs, p, { version: "1.0", shipped: ["A"] });
  };

  it("adds requirements shipped later to a released version", () => {
    const { requirements, product: p } = released();
    const out = releaseRequirements(requirements, cat(p), { product: p, version: "1.0", ids: ["C"], actor: "sam", now: NOW });
    expect(by(out, "C")).toMatchObject({ releasedIn: "1.0", releasedBy: "sam" });
    expect(() => releaseRequirements(requirements, cat(p), { product: p, version: "1.1", ids: ["C"], actor: "sam", now: NOW })).toThrow(/not released yet/);
  });

  it("corrects a release, with a reason, and records it", () => {
    const { requirements, product: p } = released();
    const reason = "Feature flag was off in the 1.0 build";
    const out = correctRelease(requirements, cat(p), { product: p, version: "1.0", reason, removeShipped: ["A"], moveTo: "1.1", actor: "sam", now: NOW });
    const a = by(out.requirements, "A");
    expect(a).toMatchObject({ plannedFor: "1.1" });
    expect(a.releasedIn).toBeUndefined();
    expect(out.product.versions[0].corrections?.[0]).toMatchObject({ by: "sam", at: NOW, reason, shipped: { added: [], removed: ["A"] }, movedTo: "1.1" });
    expect(() => correctRelease(requirements, cat(p), { product: p, version: "1.0", reason: " ", removeShipped: ["A"], moveTo: "1.1", actor: "sam", now: NOW })).toThrow(/reason/);
  });
});

describe("release report and stakeholder progress", () => {
  const S = req("S", { kind: "stakeholder", title: "Book appointments quickly", story: "As a secretary I want free slots so that I can book quickly.", stakeholderIds: undefined, product: undefined });
  const start = () => [S, req("A", { plannedFor: "1.0" }), req("B", { plannedFor: "1.0" }), req("C", { plannedFor: "1.1" })];

  it("counts released solution requirements and says when a need is fully met", () => {
    const p = product();
    const r1 = release(start(), p, { version: "1.0", shipped: ["A", "B"] });
    expect(stakeholderProgress(r1.requirements, "S", cat(r1.product))).toMatchObject({ released: 2, total: 3 });
    expect(stakeholderProgress(r1.requirements, "S", cat(r1.product)).fullyMetIn).toBeUndefined();
    const r2 = release(r1.requirements, r1.product, { version: "1.1", shipped: ["C"] });
    expect(stakeholderProgress(r2.requirements, "S", cat(r2.product))).toMatchObject({ released: 3, total: 3, fullyMetIn: "1.1" });
  });

  it("reports what a version introduced, for which needs", () => {
    const p = product();
    const r1 = release(start(), p, { version: "1.0", shipped: ["A", "B"] });
    const rep = releaseReport(r1.requirements, cat(r1.product), r1.product, "1.0");
    expect(rep.introduced.map((x) => x.id)).toEqual(["A", "B"]);
    expect(rep.introduced[0].stakeholders).toEqual([{ id: "S", title: "Book appointments quickly" }]);
    expect(rep.stakeholders).toEqual([expect.objectContaining({ id: "S", inThisVersion: "partly met", released: 2, total: 3 })]);
    const md = renderReleaseReport(rep);
    expect(md).toContain("# Clinicare Web Application 1.0: release report");
    expect(md).toContain("## Introduced");
    expect(md).toContain("- **A** ");
    expect(md).not.toContain("## Corrections");
  });

  it("shows corrections in their own section", () => {
    const p = product();
    const r1 = release(start(), p, { version: "1.0", shipped: ["A", "B"] });
    const fixed = correctRelease(r1.requirements, cat(r1.product), { product: r1.product, version: "1.0", reason: "B's flag was off", removeShipped: ["B"], moveTo: "1.1", actor: "sam", now: NOW });
    const rep = releaseReport(fixed.requirements, cat(fixed.product), fixed.product, "1.0");
    expect(rep.introduced.map((x) => x.id)).toEqual(["A"]);
    expect(rep.corrections).toHaveLength(1);
    const md = renderReleaseReport(rep);
    expect(md).toContain("## Corrections");
    expect(md).toContain("B's flag was off");
  });
});

describe("release record integrity", () => {
  const released = () => release([req("A", { plannedFor: "1.0" }), req("B", { plannedFor: "1.1" })], product(), { version: "1.0", shipped: ["A"] });

  it("refuses a correction that lists the same requirement twice", () => {
    const { requirements, product: p } = released();
    expect(() => correctRelease(requirements, cat(p), { product: p, version: "1.0", reason: "x", removeShipped: ["A"], addObsolete: ["A"], moveTo: "1.1", actor: "sam", now: NOW })).toThrow(/more than once/);
  });

  it("refuses making another product's requirement obsolete in this version", () => {
    const { requirements, product: p } = released();
    const other = req("Z", { product: "PRD-0002" });
    expect(() => correctRelease([...requirements, other], cat(p), { product: p, version: "1.0", reason: "x", addObsolete: ["Z"], actor: "sam", now: NOW })).toThrow(/isn't a solution requirement of/);
  });

  it("keeps an old report the same when needs get new requirements later", () => {
    const S = req("S", { kind: "stakeholder", title: "Need", stakeholderIds: undefined, product: undefined });
    const p = product();
    const r1 = releaseVersion([S, req("A", { plannedFor: "1.0", stakeholderIds: ["S"], approvedAt: "2026-11-01T00:00:00.000Z" })], cat(p), { product: p, version: "1.0", shipped: ["A"], actor: "sam", now: NOW });
    const before = releaseReport(r1.requirements, cat(r1.product), r1.product, "1.0").stakeholders[0];
    expect(before).toMatchObject({ inThisVersion: "fully met", released: 1, total: 1 });
    const later = [...r1.requirements, req("D", { status: "draft", stakeholderIds: ["S"] }), req("E", { plannedFor: "1.1", stakeholderIds: ["S"], approvedAt: "2026-12-20T00:00:00.000Z" })];
    expect(releaseReport(later, cat(r1.product), r1.product, "1.0").stakeholders[0]).toMatchObject({ inThisVersion: "fully met", released: 1, total: 1 });
  });

  it("marks requirements added to a release later, with when and who", () => {
    const { requirements, product: p } = released();
    const later = releaseRequirements(requirements, cat(p), { product: p, version: "1.0", ids: ["B"], actor: "alex", now: "2027-01-05T00:00:00.000Z" });
    expect(renderReleaseReport(releaseReport(later, cat(p), p, "1.0"))).toContain("added 2027-01-05 by alex");
  });
});

describe("tickets and releases", () => {
  const t = (key: string, done: boolean, linkedAt = "2026-11-01T00:00:00.000Z") => ({ tracker: "linear", key, done, linkedAt, linkedBy: "sam" });

  it("sorts planned requirements by ticket status", () => {
    const p = product();
    const rs = [
      req("A", { plannedFor: "1.0", tickets: [t("CLN-1", true), t("CLN-2", true)] }),
      req("B", { plannedFor: "1.0", tickets: [t("CLN-3", true), t("CLN-4", false)] }),
      req("C", { plannedFor: "1.0" }),
      req("D", {
        plannedFor: "1.0",
        delivery: { tracker: "linear", issueId: "x", identifier: "MER-1", state: { name: "Done", type: "completed" }, sentAt: "2026-11-01T00:00:00.000Z", syncedAt: "2026-11-01T00:00:00.000Z" },
      }),
    ];
    const pending = pendingRelease(rs, p, "1.0", cat(p));
    expect(pending.ready.map((r) => r.id)).toEqual(["A", "D"]);
    expect(pending.notReady.map((r) => r.id)).toEqual(["B"]);
    expect(pending.noTickets.map((r) => r.id)).toEqual(["C"]);
  });

  it("lists in a report only the tickets linked by the release", () => {
    const p = product();
    const out = release([req("A", { plannedFor: "1.0", tickets: [t("CLN-1", true)] })], p, { version: "1.0", shipped: ["A"] });
    const later = out.requirements.map((r) => ({ ...r, tickets: [...(r.tickets ?? []), t("CLN-9", false, "2027-01-01T00:00:00.000Z")] }));
    const rep = releaseReport(later, cat(out.product), out.product, "1.0");
    expect(rep.introduced[0].tickets.map((x) => (x as { key: string }).key)).toEqual(["CLN-1"]);
    const md = renderReleaseReport(rep);
    expect(md).toContain("  - Tickets: linear CLN-1");
    expect(md).not.toContain("CLN-9");
  });
});
