import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyCollections } from "../src/core/collections";
import { riskRegisterRows, toCsv, traceabilityRows } from "../src/core/report-rows";
import type { Requirement, Risk, TestResults } from "../src/core/types";
import { runReportCommand } from "../src/release-cli";
import { catalogueOf } from "../src/store/catalogue";
import { configSchema, readConfig } from "../src/store/config";
import { load, save } from "../src/store/files";
import { writeProduct, type Product } from "../src/store/products";
import { buildRecord, recordPath, writeRecord } from "../src/store/signoff";

const config = configSchema.parse({ name: "Acme", people: [{ id: "sam", name: "Sam", role: "owner" }] });
const product: Product = { id: "PRD-0001", title: "Acme app", areas: [], versions: [{ version: "1.1", status: "released", releasedAt: "2026-11-28T10:00:00.000Z", releasedBy: "sam" }] };
const base = { acceptanceCriteria: ["Works"], findingIds: [], priority: "must" as const, createdAt: "2026-11-01T00:00:00.000Z" };
const requirements: Requirement[] = [
  { ...base, id: "REQ-0001", title: "Correct invoices", kind: "stakeholder", story: "As a customer I want correct invoices so that I pay the right amount.", status: "approved" },
  {
    ...base,
    id: "REQ-0002",
    title: "Totals match lines",
    kind: "solution",
    story: "The invoice shall show totals that match its lines.",
    status: "approved",
    stakeholderIds: ["REQ-0001"],
    product: "PRD-0001",
    plannedFor: "1.1",
    releasedIn: "1.1",
    riskIds: ["RSK-0001"],
    codeRefs: ["src/billing/invoice.ts#total"],
    codeTests: [{ path: "test/billing.test.ts", name: "totals match", linkedAt: "x", linkedBy: "sam" }],
    testCases: [{ tool: "testrail", id: "C101", title: "Totals", linkedAt: "x", linkedBy: "sam" }],
    tickets: [
      { tracker: "linear", key: "CLN-12", state: "Done", done: true, linkedAt: "x", linkedBy: "sam" },
      { tracker: "github", key: "acme/app#57", url: "https://github.com/acme/app/pull/57", state: "merged", linkedAt: "x", linkedBy: "sam" },
    ],
  },
];
const risks: Risk[] = [
  { id: "RSK-0001", title: "Customer overcharged", hazard: "Stale lines", harm: "Overpaid invoices", probability: 4, severity: 5, residualProbability: 1, residualSeverity: 5, mitigationIds: ["REQ-0002"], product: "PRD-0001", versions: ["1.1"], createdAt: "x" },
];
const tests: TestResults = {
  fetchedAt: "",
  runs: [{ tool: "testrail", project: "", id: "R3", title: "1.1 regression" }],
  results: [{ tool: "testrail", project: "", id: "C101", runId: "R3", status: "failed", endTime: "2026-11-27T10:00:00Z" }],
  code: { runs: [], results: [{ path: "test/billing.test.ts", name: "totals match", status: "passed", runId: "run-1", commitSha: "abc1234", at: "x" }] },
};
const record = () =>
  buildRecord({ state: { ...emptyCollections(), requirements, risks }, catalogue: catalogueOf(config, [product]), config, product, version: "1.1", tests, fetch: { fetched: true, commit: null }, actor: "sam", now: "2026-11-28T10:00:00.000Z" });

describe("report rows", () => {
  it("toCsv neutralises formulas", () => {
    // Ported from the web app: a cell a spreadsheet would run as a formula gets a leading apostrophe.
    expect(toCsv([{ key: "a", label: "A" }], [{ a: "=SUM(1,2)" }, { a: 'say "hi"' }, { a: "-1" }])).toBe("A\r\n\"'=SUM(1,2)\"\r\n\"say \"\"hi\"\"\"\r\n'-1\r\n");
  });

  it("traceabilityRows lists the version's requirements with tasks, tests and risks", () => {
    const rows = traceabilityRows(record());
    expect(rows.map((r) => r.key)).toEqual(["REQ-0001", "REQ-0002"]);
    expect(rows[1]).toMatchObject({
      kind: "Solution",
      status: "Approved",
      fulfils: "REQ-0001",
      risks: "RSK-0001",
      versions: "1.1",
      tasks: "linear CLN-12 (Done)",
      tests: "1 of 2 passed, 1 failed",
      pullRequests: "acme/app#57 (merged)",
      codeRefs: "src/billing/invoice.ts#total",
    });
    expect(rows[0]).toMatchObject({ kind: "Stakeholder", fulfils: "Fulfilled by REQ-0002", tests: "Not tested directly" });
  });

  it("riskRegisterRows scores on the matrix labels", () => {
    expect(riskRegisterRows(record())).toEqual([
      {
        key: "RSK-0001",
        title: "Customer overcharged",
        hazard: "Stale lines",
        harm: "Overpaid invoices",
        initial: "Likely × Catastrophic",
        initialLevel: "High",
        residual: "Rare × Catastrophic",
        residualLevel: "Medium",
        mitigations: "REQ-0002 (Approved)",
        controlled: "No",
        versions: "1.1",
      },
    ]);
  });
});

describe("groundwork report release", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const acme = () => {
    root = mkdtempSync(join(tmpdir(), "gw-report-"));
    cpSync(join(__dirname, "../examples/acme/groundwork"), join(root, "groundwork"), { recursive: true });
    return root;
  };
  /** Sign acme 1.0 off as it is now, the way release_version would. */
  const signOff = () => {
    const loaded = load(root);
    const p = loaded.products[0];
    const rec = buildRecord({ state: loaded.items, catalogue: catalogueOf(readConfig(root), loaded.products), config: readConfig(root), product: p, version: "1.0", tests: undefined, fetch: { fetched: false, commit: null }, actor: "sam", now: "2026-11-28T10:00:00.000Z" });
    const rel = recordPath(root, p.id, "1.0");
    writeRecord(root, rel, rec);
    writeProduct(root, { ...p, versions: p.versions.map((v) => (v.version === "1.0" ? { ...v, signOff: rel } : v)) }, loaded.paths.get(p.id));
  };

  it("the report of a signed-off version comes from its record, not the files", () => {
    acme();
    signOff();
    const before = runReportCommand(root, { version: "1.0" }).lines.join("\n");
    expect(before).toContain("Signed off 2026-11-28 by Sam.");
    // Change the files after sign-off: the report doesn't move.
    const loaded = load(root);
    save(root, loaded, { ...loaded.items, requirements: loaded.items.requirements.map((r) => (r.releasedIn === "1.0" ? { ...r, title: `${r.title} (renamed later)` } : r)) });
    expect(runReportCommand(root, { version: "1.0" }).lines.join("\n")).toBe(before);
  });

  it("report --format csv prints the traceability table, --table risks the register", () => {
    acme();
    signOff();
    const csv = runReportCommand(root, { version: "1.0", format: "csv" });
    expect(csv.code).toBe(0);
    expect(csv.lines[0]).toBe("Key,Title,Kind,Status,Statement,Fulfils,Risks,Versions,Tasks,Tests,Pull requests,Code");
    const risksCsv = runReportCommand(root, { version: "1.0", format: "csv", table: "risks" });
    expect(risksCsv.lines[0]).toBe("Key,Title,Hazard,Harm,Initial score,Initial level,Residual score,Residual level,Mitigations,Controlled,Versions");
  });

  it("report on a version released before sign-off records says so", () => {
    acme();
    const out = runReportCommand(root, { version: "1.0" }).lines.join("\n");
    expect(out).toContain("Released before sign-off records: built from the current files, not a frozen record.");
    expect(out).toContain("## Tests");
    expect(out).toContain("## Risks and mitigations");
  });
});
