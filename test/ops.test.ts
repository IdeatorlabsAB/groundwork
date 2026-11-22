import { describe, expect, it } from "vitest";
import { diffCollections } from "../src/core/collections";
import * as ops from "../src/core/ops";
import { localSchemas } from "../src/core/schemas";
const { PATCHES, insightInput } = localSchemas;
import { AREA, ctx, ID, OTHER_USER, USER, workspace } from "./fixtures";

const apply = <R>(s: ReturnType<typeof workspace>, ch: ops.Change<R>) => ({ ...s, ...ch.next });

describe("creating items", () => {
  it("adds insights with id, timestamps, author and one activity entry", () => {
    const s = workspace();
    const c = ctx({ via: "Claude Code" });
    const { next, result } = ops.addInsights(s, c, [
      { title: "A", quote: "q", source: "support", persona: "p", tags: [], sentiment: "neutral" },
      { title: "B", quote: "q", source: "survey", persona: "p", tags: [], sentiment: "neutral" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ createdAt: c.now, createdBy: USER });
    expect(next.insights!.slice(0, 2)).toEqual(result);
    expect(next.activity![0]).toMatchObject({ text: "added 2 insights", actor: USER, via: "Claude Code", kind: "insight" });
  });

  it("leaves `via` off app changes", () => {
    const { next } = ops.addInsights(workspace(), ctx(), [{ title: "A", quote: "q", source: "support", persona: "p", tags: [], sentiment: "neutral" }]);
    expect(next.activity![0]).not.toHaveProperty("via");
  });

  it("gives a hypothesis the dominant area of its insights", () => {
    const s = workspace();
    const { result } = ops.addHypotheses(s, ctx(), [
      { title: "H", outcome: "o", forWhom: "f", benefit: "b", feature: "x", knowWhen: "", status: "draft", confidence: 50, insightIds: [ID.insight] },
    ]);
    expect(result[0].productArea).toBe(AREA);
    expect(result[0].owner).toBe(USER);
  });

  it("starts derived requirements as drafts", () => {
    const s = workspace();
    const { result } = ops.addRequirements(s, ctx(), [
      { title: "R", story: "s", acceptanceCriteria: ["a"], priority: "must", findingIds: [ID.finding] },
    ]);
    expect(result[0]).toMatchObject({ status: "draft", productArea: AREA });
  });
});

describe("experiments", () => {
  it("starting one moves a draft hypothesis to testing", () => {
    const s = apply(workspace(), ops.startExperiment(workspace(), ctx(), ID.experiment));
    expect(s.experiments[0].status).toBe("running");
    expect(s.hypotheses[0].status).toBe("testing");
  });

  it("recording results computes the verdict and updates the hypothesis", () => {
    const s = workspace();
    const { next, result } = ops.recordResults(s, ctx(), ID.experiment, 61, [11], "Worked");
    expect(result!.result.verdict).toBe("validated");
    expect(next.experiments![0]).toMatchObject({ status: "completed", verdict: "validated", resultNotes: "Worked" });
    expect(next.hypotheses![0]).toMatchObject({ status: "validated", confidence: 86 });
  });

  it("a breached guardrail invalidates", () => {
    const { result, next } = ops.recordResults(workspace(), ctx(), ID.experiment, 61, [20], "");
    expect(result!.result.verdict).toBe("invalidated");
    expect(next.hypotheses![0].confidence).toBe(14);
  });
});

describe("delete cascades", () => {
  it("deleting an insight unlinks it everywhere", () => {
    const s = apply(workspace(), ops.deleteInsight(workspace(), ID.insight));
    expect(s.insights.map((i) => i.id)).toEqual([ID.insight2]);
    expect(s.hypotheses[0].insightIds).toEqual([]);
    expect(s.findings[0].insightIds).toEqual([]);
  });

  it("deleting a hypothesis deletes its experiments", () => {
    const s = apply(workspace(), ops.deleteHypothesis(workspace(), ID.hypothesis));
    expect(s.hypotheses).toEqual([]);
    expect(s.experiments).toEqual([]);
  });

  it("deleting an experiment unlinks it from findings", () => {
    const s = apply(workspace(), ops.deleteExperiment(workspace(), ID.experiment));
    expect(s.findings[0].experimentIds).toEqual([]);
  });

  it("deleting a stakeholder requirement unlinks it from solution requirements", () => {
    const s = apply(workspace(), ops.deleteRequirement(workspace(), ID.stakeholderReq));
    expect(s.requirements.find((r) => r.id === ID.solutionReq)!.stakeholderIds).toEqual([]);
  });
});

describe("requirement status rules", () => {
  it("submits only drafts", () => {
    expect(ops.submitRequirement(workspace(), ctx(), ID.stakeholderReq, USER).result).toBe(true);
    expect(ops.submitRequirement(workspace(), ctx(), ID.approvedReq, USER).result).toBe(false);
  });

  it("approves and records who approved", () => {
    const s = apply(workspace(), ops.approveRequirement(workspace(), ctx(), ID.solutionReq));
    expect(s.requirements.find((r) => r.id === ID.solutionReq)).toMatchObject({ status: "approved", approvedBy: USER });
  });

  it("records an approval given by someone else", () => {
    const s = apply(workspace(), ops.approveRequirement(workspace(), ctx(), ID.stakeholderReq, { approvedBy: OTHER_USER, note: "Verbal, sprint planning" }));
    expect(s.requirements.find((r) => r.id === ID.stakeholderReq)).toMatchObject({
      status: "approved",
      approvedBy: OTHER_USER,
      recordedBy: USER,
      approvalNote: "Verbal, sprint planning",
      approver: OTHER_USER,
    });
  });

  it("doesn't store recordedBy when you approve yourself", () => {
    const s = apply(workspace(), ops.approveRequirement(workspace(), ctx(), ID.solutionReq, { approvedBy: USER }));
    const r = s.requirements.find((x) => x.id === ID.solutionReq)!;
    expect(r.approvedBy).toBe(USER);
    expect(r.recordedBy).toBeUndefined();
  });

  it("plans requirements for a version, and moves the obsolescence of what they replace", () => {
    const w = workspace();
    w.requirements = w.requirements.map((r) =>
      r.id === ID.solutionReq ? { ...r, replaces: [ID.approvedReq] } : r.id === ID.approvedReq ? { ...r, obsoletePlannedFor: "1.1", obsoletedBy: [ID.solutionReq] } : r,
    );
    const s = apply(w, ops.planRequirements(w, ctx(), [ID.solutionReq], "1.2"));
    expect(s.requirements.find((r) => r.id === ID.solutionReq)?.plannedFor).toBe("1.2");
    expect(s.requirements.find((r) => r.id === ID.approvedReq)?.obsoletePlannedFor).toBe("1.2");
  });

  it("plans obsolescence without changing the status", () => {
    const s = apply(workspace(), ops.planObsolescence(workspace(), ctx(), [ID.approvedReq], "1.2", [ID.solutionReq]));
    expect(s.requirements.find((r) => r.id === ID.approvedReq)).toMatchObject({ status: "approved", obsoletePlannedFor: "1.2", obsoletedBy: [ID.solutionReq] });
  });

  it("only approved requirements can be made obsolete", () => {
    expect(ops.obsoleteRequirement(workspace(), ctx(), ID.solutionReq).result).toBe(false);
    const s = apply(workspace(), ops.obsoleteRequirement(workspace(), ctx(), ID.approvedReq, [ID.solutionReq]));
    expect(s.requirements.find((r) => r.id === ID.approvedReq)).toMatchObject({ status: "obsolete", obsoletedBy: [ID.solutionReq] });
  });
});

describe("diffCollections", () => {
  it("sends only new, changed and removed items", () => {
    const before = workspace();
    const after = apply(before, ops.updateInsight(before, ID.insight, { title: "Renamed" }));
    const withDelete = apply(after, ops.deleteFinding(after, ID.finding));
    const { upserts, deletes } = diffCollections(before, withDelete);
    expect(deletes).toEqual([ID.finding]);
    // The renamed insight, plus requirements whose findingIds were rewritten by the cascade.
    expect(upserts.map((u) => u.id)).toContain(ID.insight);
    expect(upserts.find((u) => u.id === ID.insight)!.data).not.toHaveProperty("id");
    expect(upserts.some((u) => u.id === ID.insight2)).toBe(false);
  });
});

describe("input schemas", () => {
  it("fills defaults on create", () => {
    expect(insightInput.parse({ title: "t", quote: "q", source: "interview", persona: "p" })).toMatchObject({ tags: [], sentiment: "neutral" });
  });

  it("patches don't inject defaults for fields that weren't sent", () => {
    for (const [kind, patch] of Object.entries({ insight: { title: "x" }, hypothesis: { title: "x" }, experiment: { title: "x" }, finding: { title: "x" }, requirement: { title: "x" } })) {
      expect(PATCHES[kind as keyof typeof PATCHES].strict().parse(patch), kind).toEqual({ title: "x" });
    }
  });

  it("rejects unknown fields in a patch", () => {
    expect(PATCHES.insight.strict().safeParse({ createdBy: "someone" }).success).toBe(false);
  });
});
