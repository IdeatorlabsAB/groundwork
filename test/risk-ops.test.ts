import { describe, expect, it } from "vitest";
import * as ops from "../src/core/ops";
import type { Collections } from "../src/core/collections";
import { ctx, ID, workspace } from "./fixtures";

const apply = <R>(s: Collections, ch: ops.Change<R>): [Collections, R] => [{ ...s, ...ch.next }, ch.result];

const newRisk = (over: Partial<ops.NewRisk> = {}): ops.NewRisk => ({
  title: "Import attributed to the wrong user",
  hazard: "The importer records the service account instead of the person.",
  harm: "Auditors can't tell who imported patient data.",
  probability: 3,
  severity: 5,
  mitigationIds: [],
  versions: [],
  ...over,
});

function withRisk(): [Collections, string] {
  const [s, created] = apply(workspace(), ops.addRisks(workspace(), ctx(), [newRisk()]));
  return [s, created[0].id];
}

describe("risk ops", () => {
  it("addRisks puts new risks first with createdAt", () => {
    const c = ctx();
    const [s0] = withRisk();
    const [s, created] = apply(s0, ops.addRisks(s0, c, [newRisk({ title: "Second" })]));
    expect(s.risks[0]).toBe(created[0]);
    expect(s.risks).toHaveLength(2);
    expect(created[0].createdAt).toBe(c.now);
    expect(s.activity[0].kind).toBe("risk");
    expect(s.activity[0].text).toBe("added 1 risk");
  });

  it("linkMitigation adds the id on both sides and is idempotent", () => {
    const [s0, riskId] = withRisk();
    const [s1, ok1] = apply(s0, ops.linkMitigation(s0, ctx(), riskId, ID.approvedReq));
    expect(ok1).toBe(true);
    expect(s1.risks[0].mitigationIds).toEqual([ID.approvedReq]);
    expect(s1.requirements.find((r) => r.id === ID.approvedReq)!.riskIds).toEqual([riskId]);
    const again = ops.linkMitigation(s1, ctx(), riskId, ID.approvedReq);
    expect(again.result).toBe(true);
    expect(again.next).toEqual({});
  });

  it("linkMitigation returns false for an unknown risk or requirement", () => {
    const [s0, riskId] = withRisk();
    expect(ops.linkMitigation(s0, ctx(), "nope", ID.approvedReq).result).toBe(false);
    expect(ops.linkMitigation(s0, ctx(), riskId, "nope").result).toBe(false);
  });

  it("unlinkMitigation removes the id on both sides", () => {
    const [s0, riskId] = withRisk();
    const [s1] = apply(s0, ops.linkMitigation(s0, ctx(), riskId, ID.approvedReq));
    const [s2, ok] = apply(s1, ops.unlinkMitigation(s1, ctx(), riskId, ID.approvedReq));
    expect(ok).toBe(true);
    expect(s2.risks[0].mitigationIds).toEqual([]);
    expect(s2.requirements.find((r) => r.id === ID.approvedReq)!.riskIds).toEqual([]);
  });

  it("deleteRisk drops it from requirements' riskIds", () => {
    const [s0, riskId] = withRisk();
    const [s1] = apply(s0, ops.linkMitigation(s0, ctx(), riskId, ID.approvedReq));
    const [s2] = apply(s1, ops.deleteRisk(s1, riskId));
    expect(s2.risks).toEqual([]);
    expect(s2.requirements.find((r) => r.id === ID.approvedReq)!.riskIds).toEqual([]);
  });

  it("deleteRequirement drops it from risks' mitigationIds", () => {
    const [s0, riskId] = withRisk();
    const [s1] = apply(s0, ops.linkMitigation(s0, ctx(), riskId, ID.approvedReq));
    const [s2] = apply(s1, ops.deleteRequirement(s1, ID.approvedReq));
    expect(s2.risks[0].mitigationIds).toEqual([]);
  });

  it("updateRisk sets updatedAt to ctx.now", () => {
    const [s0, riskId] = withRisk();
    const c = ctx({ now: "2026-12-01T00:00:00.000Z" });
    const [s1] = apply(s0, ops.updateRisk(s0, c, riskId, { residualProbability: 1 }));
    expect(s1.risks[0].residualProbability).toBe(1);
    expect(s1.risks[0].updatedAt).toBe(c.now);
  });
});

describe("risk schemas", () => {
  it("LOCAL_ID and ID_PREFIX know RSK", async () => {
    const { LOCAL_ID, ID_PREFIX, KIND } = await import("../src/core/schemas");
    expect(LOCAL_ID.test("RSK-0007")).toBe(true);
    expect(ID_PREFIX.risk).toBe("RSK");
    expect(KIND.options).toContain("risk");
  });

  it("riskInput fills defaults and has no mitigationIds", async () => {
    const { localSchemas } = await import("../src/core/schemas");
    const r = localSchemas.riskInput.parse({ title: "Wrong dose shown", probability: 2, severity: 5, category: "domain", domain: "patient-safety" });
    expect(r).toMatchObject({ hazard: "", harm: "", versions: [], category: "domain", domain: "patient-safety" });
    expect(localSchemas.riskInput.strict().safeParse({ title: "x", probability: 1, severity: 1, mitigationIds: [] }).success).toBe(false);
    expect(localSchemas.PATCHES.risk.safeParse({ residualSeverity: 2 }).success).toBe(true);
  });
});
