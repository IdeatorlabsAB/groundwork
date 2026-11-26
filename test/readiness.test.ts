import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseReadiness, type Tests } from "../src/core/readiness";
import { defaultMatrix } from "../src/core/risk";
import type { Requirement, Risk } from "../src/core/types";

type Scenario = {
  name: string;
  requirements: Partial<Requirement>[];
  risks: Partial<Risk>[];
  scope: { requirements: string[]; risks: string[] };
  tests: "unchecked" | null | { results: unknown[]; code: { path: string; name: string; status: string }[] };
  blockers: unknown[];
};
const { scenarios } = JSON.parse(readFileSync(join(__dirname, "fixtures/parity/readiness.json"), "utf8")) as { scenarios: Scenario[] };

const requirement = (r: Partial<Requirement>): Requirement =>
  ({
    kind: "solution",
    story: "The app shall work.",
    acceptanceCriteria: ["Works"],
    findingIds: [],
    stakeholderIds: ["S1"],
    createdAt: "2026-11-01T00:00:00.000Z",
    ...r,
    codeTests: r.codeTests?.map((t) => ({ linkedAt: "", linkedBy: "", ...(t as object) })),
    testCases: r.testCases?.map((t) => ({ linkedAt: "", linkedBy: "", ...(t as object) })),
  }) as Requirement;
const risk = (r: Partial<Risk>): Risk => ({ hazard: "", harm: "", versions: [], createdAt: "x", ...r }) as Risk;
const testsOf = (t: Scenario["tests"]): Tests =>
  t === "unchecked"
    ? undefined
    : t === null
      ? null
      : {
          fetchedAt: "",
          runs: [],
          results: t.results as never,
          code: { runs: [], results: t.code.map((c) => ({ ...c, runId: "run", commitSha: "abc", at: "2026-11-27T10:00:00.000Z" })) as never },
        };

describe("release readiness", () => {
  it("readiness matches the parity fixture", () => {
    for (const s of scenarios) {
      const all = s.requirements.map(requirement);
      const risks = s.risks.map(risk);
      const scope = { requirements: all.filter((r) => s.scope.requirements.includes(r.id)), risks: risks.filter((r) => s.scope.risks.includes(r.id)) };
      const out = releaseReadiness(defaultMatrix(5), scope, all, testsOf(s.tests));
      expect(out.blockers, s.name).toEqual(s.blockers);
      expect(out.ok, s.name).toBe(s.blockers.length === 0);
    }
  });

  it("tests undefined checks no tests", () => {
    const r = requirement({ id: "R1", title: "Totals", status: "approved" });
    expect(releaseReadiness(defaultMatrix(5), { requirements: [r], risks: [] }, [r], undefined).blockers).toEqual([]);
  });
});
