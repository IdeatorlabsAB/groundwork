import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Collections } from "../src/core/collections";
import * as ops from "../src/core/ops";
import { caseKey, sameCase } from "../src/core/test-links";
import { ctx, ID, workspace } from "./fixtures";

type Ref = { tool: string; project?: string; id: string };
const parity = JSON.parse(readFileSync(join(__dirname, "fixtures/parity/test-cases.json"), "utf8")) as { same: [Ref, Ref][]; different: [Ref, Ref][] };
const apply = <R>(s: Collections, ch: ops.Change<R>): [Collections, R] => [{ ...s, ...ch.next }, ch.result];
const req = (s: Collections, id = ID.solutionReq) => s.requirements.find((r) => r.id === id)!;

describe("test case identity", () => {
  it("caseKey matches the parity fixture", () => {
    for (const [a, b] of parity.same) expect(sameCase(a, b), JSON.stringify([a, b])).toBe(true);
    for (const [a, b] of parity.different) expect(caseKey(a) === caseKey(b), JSON.stringify([a, b])).toBe(false);
  });
});

describe("code test ops", () => {
  it("linkCodeTests skips tests already linked and duplicates in the input", () => {
    const t = { path: "test/import.test.ts", name: "import > REQ-0002 maps columns" };
    const c = ctx();
    const [s1, n1] = apply(workspace(), ops.linkCodeTests(workspace(), c, ID.solutionReq, [t, t]));
    expect(n1).toBe(1);
    expect(req(s1).codeTests).toEqual([{ ...t, linkedAt: c.now, linkedBy: c.actor }]);
    const again = ops.linkCodeTests(s1, ctx(), ID.solutionReq, [t]);
    expect(again.result).toBe(0);
    expect(again.next).toEqual({});
  });

  it("unlinkCodeTests removes by path and name", () => {
    const a = { path: "test/a.test.ts", name: "a" };
    const b = { path: "test/a.test.ts", name: "b" };
    const [s1] = apply(workspace(), ops.linkCodeTests(workspace(), ctx(), ID.solutionReq, [a, b]));
    const [s2, n] = apply(s1, ops.unlinkCodeTests(s1, ctx(), ID.solutionReq, [a]));
    expect(n).toBe(1);
    expect(req(s2).codeTests!.map((x) => x.name)).toEqual(["b"]);
  });
});

describe("test case ops", () => {
  const qase = { tool: "qase", project: "ACME", id: "12", title: "Maps columns" };
  const rail = { tool: "testrail", project: "ACME", id: "12", title: "Maps columns (TestRail)" };

  it("linkTestCases keeps cases from two tools with the same id apart", () => {
    const [s1, n] = apply(workspace(), ops.linkTestCases(workspace(), ctx(), ID.solutionReq, [qase, rail]));
    expect(n).toBe(2);
    expect(req(s1).testCases!.map((x) => x.tool)).toEqual(["qase", "testrail"]);
  });

  it("linkTestCases refreshes the title and keeps linkedAt", () => {
    const first = ctx({ now: "2026-11-01T00:00:00.000Z" });
    const [s1] = apply(workspace(), ops.linkTestCases(workspace(), first, ID.solutionReq, [qase]));
    const [s2, n] = apply(s1, ops.linkTestCases(s1, ctx({ now: "2026-12-01T00:00:00.000Z" }), ID.solutionReq, [{ ...qase, project: "acme", title: "Maps every column", url: "https://app.qase.io/case/ACME-12" }]));
    expect(n).toBe(0);
    expect(req(s2).testCases).toEqual([{ ...qase, title: "Maps every column", url: "https://app.qase.io/case/ACME-12", linkedAt: first.now, linkedBy: first.actor }]);
  });

  it("linkTestCases refuses a stakeholder or obsolete requirement", () => {
    expect(ops.linkTestCases(workspace(), ctx(), ID.stakeholderReq, [qase])).toEqual({ next: {}, result: 0 });
    const s = workspace();
    const obsolete = { ...s, requirements: s.requirements.map((r) => (r.id === ID.solutionReq ? { ...r, status: "obsolete" as const } : r)) };
    expect(ops.linkTestCases(obsolete, ctx(), ID.solutionReq, [qase])).toEqual({ next: {}, result: 0 });
  });

  it("unlinkTestCases removes by tool, project and id, and clears the list when empty", () => {
    const [s1] = apply(workspace(), ops.linkTestCases(workspace(), ctx(), ID.solutionReq, [qase, rail]));
    const [s2, n] = apply(s1, ops.unlinkTestCases(s1, ctx(), ID.solutionReq, [{ tool: "QASE", project: "acme", id: "12" }]));
    expect(n).toBe(1);
    expect(req(s2).testCases!.map((x) => x.tool)).toEqual(["testrail"]);
    const [s3] = apply(s2, ops.unlinkTestCases(s2, ctx(), ID.solutionReq, [rail]));
    expect(req(s3).testCases).toBeUndefined();
  });
});
