import { describe, expect, it } from "vitest";
import { CODE_RUN_WINDOW, latestCodeResults, type CodeRun } from "../src/core/code-runs";

const run = (id: string, at: string, results: CodeRun["results"]): CodeRun => ({ id, commitSha: `${id}000000`, ref: "refs/heads/main", at, results });

describe("latestCodeResults", () => {
  it("takes each test's result from the newest run that has it", () => {
    const runs = [
      run("new", "2026-11-25T12:00:00Z", [
        { path: "a.test.ts", name: "fixed", status: "passed" },
        { path: "a.test.ts", name: "broke", status: "failed" },
      ]),
      run("old", "2026-11-25T10:00:00Z", [
        { path: "a.test.ts", name: "fixed", status: "failed" },
        { path: "a.test.ts", name: "broke", status: "passed" },
      ]),
    ];
    expect(latestCodeResults(runs)).toEqual([
      { path: "a.test.ts", name: "fixed", status: "passed", runId: "new", commitSha: "new000000", at: "2026-11-25T12:00:00Z" },
      { path: "a.test.ts", name: "broke", status: "failed", runId: "new", commitSha: "new000000", at: "2026-11-25T12:00:00Z" },
    ]);
  });

  it("keeps tests missing from the newest run at their older result", () => {
    const runs = [
      run("unit", "2026-11-25T12:00:00Z", [{ path: "unit.test.ts", name: "u", status: "passed" }]),
      run("e2e", "2026-11-25T11:00:00Z", [{ path: "e2e.spec.ts", name: "e", status: "passed" }]),
    ];
    expect(latestCodeResults(runs).map((r) => [r.path, r.runId])).toEqual([
      ["unit.test.ts", "unit"],
      ["e2e.spec.ts", "e2e"],
    ]);
  });

  it("drops a test that a newer run of its file no longer has (deleted or renamed)", () => {
    const runs = [
      run("new", "2026-11-25T12:00:00Z", [{ path: "a.test.ts", name: "kept", status: "passed" }]),
      run("old", "2026-11-25T10:00:00Z", [
        { path: "a.test.ts", name: "kept", status: "passed" },
        { path: "a.test.ts", name: "deleted", status: "passed" },
      ]),
    ];
    expect(latestCodeResults(runs).map((r) => r.name)).toEqual(["kept"]);
  });

  it("sorts runs itself", () => {
    const runs = [
      run("old", "2026-11-25T10:00:00Z", [{ path: "a.test.ts", name: "x", status: "failed" }]),
      run("new", "2026-11-25T12:00:00Z", [{ path: "a.test.ts", name: "x", status: "passed" }]),
    ];
    expect(latestCodeResults(runs)[0]).toMatchObject({ status: "passed", runId: "new" });
  });

  it("looks back 30 runs", () => {
    expect(CODE_RUN_WINDOW).toBe(30);
  });
});
