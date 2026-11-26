import { describe, expect, it } from "vitest";
import { emptyCollections, type Collections } from "../src/core/collections";
import type { Requirement } from "../src/core/types";
import { recordBaseline, type BaselineInput } from "../src/store/baseline";
import { catalogueOf } from "../src/store/catalogue";
import { configSchema } from "../src/store/config";
import type { Product } from "../src/store/products";
import { releaseVersion } from "../src/store/release";
import { ctx } from "./fixtures";

const NOW = "2026-12-15T10:00:00.000Z";
const product = (versions: Product["versions"] = [{ version: "1.0", status: "planned" }]): Product => ({
  id: "PRD-0001",
  title: "Clinicare Web Application",
  areas: [{ id: "billing", label: "Billing" }],
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
const c = () => ctx({ actor: "sam", now: NOW });
const hypothesis = (key: string) => ({
  key,
  title: "Invoices by email",
  outcome: "fewer late payments",
  forWhom: "clinic admins",
  benefit: "invoices land where they work",
  feature: "emailed invoices",
  knowWhen: "",
  confidence: 80,
  insightIds: [],
});
const story = (title: string) => ({ title, story: `The system shall ${title}.`, acceptanceCriteria: ["works"], priority: "must" as const });
const input = (p: Product, over: Partial<BaselineInput> = {}): BaselineInput => ({
  product: p,
  version: "legacy",
  approvedBy: "maria",
  area: "billing",
  hypotheses: [hypothesis("h1")],
  stakeholder: [{ ...story("bill patients"), stakeholder: "Clinic admins", key: "s1", hypothesisKeys: ["h1"] }],
  solution: [
    { ...story("email invoices"), stakeholderKeys: ["s1"] },
    { ...story("print invoices"), stakeholderKeys: ["s1"] },
  ],
  ...over,
});
const by = (s: Collections, id: string) => s.requirements.find((r) => r.id === id)!;

describe("recording a baseline", () => {
  it("records linked hypotheses and requirements, approved and released", () => {
    const p = product();
    const out = recordBaseline(emptyCollections(), cat(p), input(p), c());
    const h = out.state.hypotheses.find((x) => x.id === out.created.hypotheses.h1)!;
    expect(h).toMatchObject({ status: "validated", origin: "inferred", originNote: "Reverse-engineered from the existing product", productArea: "billing" });
    const s1 = out.created.stakeholder.s1;
    expect(out.created.solution).toHaveLength(2);
    for (const id of [s1, ...out.created.solution]) {
      expect(by(out.state, id)).toMatchObject({ status: "approved", origin: "existing-product", approvedBy: "maria", recordedBy: "sam", approvedAt: NOW, product: "PRD-0001" });
    }
    expect(by(out.state, s1)).toMatchObject({ kind: "stakeholder", hypothesisIds: [out.created.hypotheses.h1] });
    for (const id of out.created.solution) {
      expect(by(out.state, id)).toMatchObject({ kind: "solution", releasedIn: "legacy", plannedFor: "legacy", stakeholderIds: [s1], approvalNote: "Recorded as the as-is baseline" });
    }
    expect(out.product.versions[0]).toMatchObject({ version: "legacy", status: "released" });
    expect(out.product.versions[1].version).toBe("1.0");
    expect(out.warnings).toEqual([]);
  });

  it("appends the source ref to the origin note, and keeps an item's own note", () => {
    const p = product();
    const out = recordBaseline(
      emptyCollections(),
      cat(p),
      input(p, { sourceRef: "v4.2", solution: [{ ...story("email invoices"), stakeholderKeys: ["s1"], originNote: "From the billing module" }] }),
      ctx({ actor: "maria", now: NOW }),
    );
    expect(by(out.state, out.created.stakeholder.s1).originNote).toBe("Reverse-engineered from the existing product @ v4.2");
    expect(by(out.state, out.created.solution[0])).toMatchObject({ originNote: "From the billing module" });
    expect(by(out.state, out.created.solution[0]).recordedBy).toBeUndefined();
  });

  it("adds a second area to the released baseline", () => {
    const p = product();
    const first = recordBaseline(emptyCollections(), cat(p), input(p), c());
    const s1 = first.created.stakeholder.s1;
    const second = recordBaseline(
      first.state,
      cat(first.product),
      input(first.product, { hypotheses: [], stakeholder: [], solution: [{ ...story("send reminders"), stakeholderIds: [s1] }] }),
      c(),
    );
    const id = second.created.solution[0];
    expect(by(second.state, id)).toMatchObject({ releasedIn: "legacy", stakeholderIds: [s1] });
    expect(second.product.versions[0]).toMatchObject({ version: "legacy", status: "released" });
    expect(second.product.versions).toHaveLength(2);
  });

  it("warns about a title already in the baseline area", () => {
    const p = product();
    const first = recordBaseline(emptyCollections(), cat(p), input(p), c());
    const second = recordBaseline(first.state, cat(first.product), input(first.product, { hypotheses: [], stakeholder: [], solution: [{ ...story("Email Invoices") }] }), c());
    expect(second.warnings).toEqual([`"Email Invoices" matches ${first.created.solution[0]} already in the baseline area`]);
  });

  it("refuses a version with other work planned", () => {
    const p = product();
    const state = { ...emptyCollections(), requirements: [req("X", { plannedFor: "1.0" })] };
    expect(() => recordBaseline(state, cat(p), input(p, { version: "1.0" }), c())).toThrow(/X/);
  });

  it("refuses a planned removal in the named version", () => {
    const p = product();
    const state = { ...emptyCollections(), requirements: [req("X", { obsoletePlannedFor: "1.0" })] };
    expect(() => recordBaseline(state, cat(p), input(p, { version: "1.0" }), c())).toThrow(/other work planned.*X/);
  });

  it("refuses a duplicate key", () => {
    const p = product();
    expect(() => recordBaseline(emptyCollections(), cat(p), input(p, { hypotheses: [hypothesis("h1"), hypothesis("h1")] }), c())).toThrow(/Duplicate key "h1" in hypotheses/);
    const dup = { ...story("bill patients"), stakeholder: "Clinic admins", key: "s1" };
    expect(() => recordBaseline(emptyCollections(), cat(p), input(p, { stakeholder: [dup, { ...dup, title: "other" }] }), c())).toThrow(/Duplicate key "s1" in stakeholder/);
  });

  it("refuses a released version with non-baseline requirements", () => {
    const p = product([{ version: "1.0", status: "released" }]);
    const state = { ...emptyCollections(), requirements: [req("X", { plannedFor: "1.0", releasedIn: "1.0" })] };
    expect(() => recordBaseline(state, cat(p), input(p, { version: "1.0" }), c())).toThrow(/X/);
  });

  it("refuses an unknown key", () => {
    const p = product();
    expect(() => recordBaseline(emptyCollections(), cat(p), input(p, { solution: [{ ...story("x"), stakeholderKeys: ["nope"] }] }), c())).toThrow(/Unknown key.*nope/);
    expect(() =>
      recordBaseline(emptyCollections(), cat(p), input(p, { stakeholder: [{ ...story("y"), key: "s1", hypothesisKeys: ["h9"] }], solution: [] }), c()),
    ).toThrow(/Unknown key.*h9/);
  });

  it("a replacement shipping later makes the baseline requirement obsolete", () => {
    const p = product();
    const out = recordBaseline(emptyCollections(), cat(p), input(p), c());
    const baselineId = out.created.solution[0];
    const requirements = [
      req("N", { plannedFor: "1.0", replaces: [baselineId] }),
      ...out.state.requirements.map((r) => (r.id === baselineId ? { ...r, obsoletedBy: ["N"], obsoletePlannedFor: "1.0" } : r)),
    ];
    const released = releaseVersion(requirements, cat(out.product), { product: out.product, version: "1.0", shipped: ["N"], actor: "sam", now: NOW });
    expect(released.requirements.find((r) => r.id === baselineId)).toMatchObject({ status: "obsolete", obsoletedIn: "1.0" });
  });
});

describe("baseline risks", () => {
  const risk = (title = "Invoice sent to the wrong patient") => ({
    title,
    hazard: "Invoices are matched to patients by name only.",
    harm: "A patient sees another patient's treatment on their invoice.",
    probability: 2,
    severity: 4,
    category: "domain" as const,
    domain: "patient-privacy",
  });
  const withKeys = (p: Product, over: Partial<BaselineInput> = {}) =>
    input(p, {
      solution: [
        { ...story("email invoices"), key: "email", stakeholderKeys: ["s1"] },
        { ...story("print invoices"), stakeholderKeys: ["s1"] },
      ],
      ...over,
    });

  it("record_baseline adds risks tagged for the baseline version with origin existing-product", () => {
    const p = product();
    const out = recordBaseline(emptyCollections(), cat(p), withKeys(p, { risks: [risk()] }), c());
    expect(out.created.risks).toHaveLength(1);
    expect(out.state.risks[0]).toMatchObject({
      title: "Invoice sent to the wrong patient",
      product: "PRD-0001",
      versions: ["legacy"],
      origin: "existing-product",
      originNote: "Reverse-engineered from the existing product",
      aiGenerated: true,
      productArea: "billing",
      mitigationIds: [],
    });
  });

  it("baseline risk mitigationKeys link to the baseline's solution requirements on both sides", () => {
    const p = product();
    const existing = { ...emptyCollections(), requirements: [req("REQ-0009", { releasedIn: "legacy" })] };
    const out = recordBaseline(existing, cat(p), withKeys(p, { risks: [{ ...risk(), mitigationKeys: ["email"], mitigationIds: ["REQ-0009"] }] }), c());
    const r = out.state.risks[0];
    const email = out.created.solution[0];
    expect(r.mitigationIds).toEqual([email, "REQ-0009"]);
    expect(by(out.state, email).riskIds).toEqual([r.id]);
    expect(by(out.state, "REQ-0009").riskIds).toEqual([r.id]);
  });

  it("baseline refuses an unknown mitigation key", () => {
    const p = product();
    expect(() => recordBaseline(emptyCollections(), cat(p), withKeys(p, { risks: [{ ...risk(), mitigationKeys: ["nope"] }] }), c())).toThrow("Unknown key nope.");
  });

  it("baseline warns about a risk title already in the area", () => {
    const p = product();
    const existing = {
      ...emptyCollections(),
      risks: [{ id: "RSK-0003", ...risk(), mitigationIds: [], versions: [], productArea: "billing", createdAt: "2026-11-01T00:00:00.000Z" }],
    };
    const out = recordBaseline(existing, cat(p), withKeys(p, { risks: [risk("invoice sent to the WRONG patient")] }), c());
    expect(out.warnings).toContain('Risk "invoice sent to the WRONG patient" matches RSK-0003 already in this area.');
  });
});
