import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyCollections, type Collections } from "../src/core/collections";
import type { Requirement, Risk, TestResults } from "../src/core/types";
import { catalogueOf } from "../src/store/catalogue";
import { configSchema, readConfig, writeConfig } from "../src/store/config";
import { load } from "../src/store/files";
import { writeProduct, type Product } from "../src/store/products";
import { activeRecord, buildRecord, loadRecords, recordPath, versionScope, withdrawRecord, writeRecord, type SignOffRecord } from "../src/store/signoff";
import { validate } from "../src/store/validate";

const config = configSchema.parse({ name: "Acme", people: [{ id: "sam", name: "Sam", role: "owner" }] });
const product = (versions: Product["versions"] = [{ version: "1.0", status: "released", releasedAt: "2026-10-01T00:00:00.000Z", releasedBy: "sam" }, { version: "1.1", status: "planned" }]): Product => ({
  id: "PRD-0001",
  title: "Acme app",
  areas: [],
  versions,
});
const req = (id: string, over: Partial<Requirement> = {}): Requirement => ({
  id,
  title: `Title ${id}`,
  kind: "solution",
  story: "The app shall work.",
  acceptanceCriteria: ["Works"],
  priority: "must",
  status: "approved",
  stakeholderIds: ["REQ-0001"],
  product: "PRD-0001",
  findingIds: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});
const risk = (id: string, over: Partial<Risk> = {}): Risk => ({
  id,
  title: `Risk ${id}`,
  hazard: "h",
  harm: "x",
  probability: 2,
  severity: 2,
  mitigationIds: [],
  product: "PRD-0001",
  versions: ["1.1"],
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});
const passing: TestResults = { fetchedAt: "", runs: [], results: [], code: { runs: [], results: [{ path: "test/a.test.ts", name: "a", status: "passed", runId: "r", commitSha: "abc", at: "x" }] } };

function state(over: Partial<Collections> = {}): Collections {
  return {
    ...emptyCollections(),
    requirements: [
      req("REQ-0001", { kind: "stakeholder", stakeholderIds: undefined, story: "As a user I want it so that it works.", product: undefined }),
      req("REQ-0002", { plannedFor: "1.1", codeTests: [{ path: "test/a.test.ts", name: "a", linkedAt: "", linkedBy: "" }] }),
      req("REQ-0003", { plannedFor: "1.2" }),
      req("REQ-0004", { plannedFor: "1.0", releasedIn: "1.0", releasedAt: "2026-10-01T00:00:00.000Z" }),
      req("REQ-0005", { plannedFor: "1.1", status: "obsolete" }),
    ],
    ...over,
  };
}
const build = (s: Collections, p = product(), version = "1.1", tests: TestResults | undefined = passing) =>
  buildRecord({ state: s, catalogue: catalogueOf(config, [p]), config, product: p, version, tests, fetch: { fetched: true, commit: "c0ffee" }, actor: "sam", now: "2026-11-28T10:00:00.000Z" });

describe("versionScope", () => {
  it("versionScope of a planned version is what's planned", () => {
    expect(versionScope(state(), catalogueOf(config, [product()]), product(), "1.1").requirements.map((r) => r.id)).toEqual(["REQ-0002"]);
  });

  it("versionScope of a released version is what shipped", () => {
    expect(versionScope(state(), catalogueOf(config, [product()]), product(), "1.0").requirements.map((r) => r.id)).toEqual(["REQ-0004"]);
  });

  it("risks are in scope when tagged for the version", () => {
    const s = state({ risks: [risk("RSK-0001"), risk("RSK-0002", { versions: ["1.2"] })] });
    expect(versionScope(s, catalogueOf(config, [product()]), product(), "1.1").risks.map((r) => r.id)).toEqual(["RSK-0001"]);
  });
});

describe("buildRecord", () => {
  it("buildRecord embeds blockers, levels, test outcomes and names", () => {
    const s = state({ risks: [risk("RSK-0001", { probability: 5, severity: 5 })] });
    const r = build(s);
    expect(r).toMatchObject({ schemaVersion: 1, kind: "release", product: { id: "PRD-0001", title: "Acme app" }, version: "1.1", signedAt: "2026-11-28T10:00:00.000Z", signedOffBy: { id: "sam", name: "Sam" }, people: { sam: "Sam" } });
    expect(r.blockers.map((b) => b.type)).toEqual(["missing-mitigation"]);
    expect(r.risks[0]).toMatchObject({ id: "RSK-0001", initialLevel: "high", residualLevel: null, mitigated: false });
    expect(r.tests).toMatchObject({ fetchedAt: "2026-11-28T10:00:00.000Z", fetched: true, resultsCommit: "c0ffee" });
    expect(r.tests!.requirements["REQ-0002"].status).toBe("passed");
    expect(r.requirements.map((x) => x.id)).toEqual(["REQ-0001", "REQ-0002"]);
    expect(r.report.version.version).toBe("1.1");
  });

  it("record includes mitigations shipped earlier", () => {
    const s = state({ risks: [risk("RSK-0001", { probability: 5, severity: 5, residualProbability: 1, residualSeverity: 1, mitigationIds: ["REQ-0004"] })] });
    const r = build(s);
    expect(r.requirements.map((x) => x.id)).toEqual(["REQ-0001", "REQ-0002", "REQ-0004"]);
    expect(r.requirements[2]).toMatchObject({ plannedFor: "1.0", releasedIn: "1.0" });
    expect(r.blockers).toEqual([]);
  });

  it("a baseline record has no tests section", () => {
    const s = state({ requirements: [req("REQ-0001", { kind: "stakeholder", stakeholderIds: undefined, product: undefined }), req("REQ-0002", { plannedFor: "1.0", releasedIn: "1.0", origin: "existing-product" })] });
    const r = build(s, product(), "1.0");
    expect(r.kind).toBe("baseline");
    expect(r.tests).toBeUndefined();
    expect(r.blockers).toEqual([]);
  });

  it("a record of 300 requirements stays under 600 KB", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      req(`REQ-${String(i + 10).padStart(4, "0")}`, {
        plannedFor: "1.1",
        story: "The app shall do a thing that takes a sentence or two to describe properly, with some detail.",
        acceptanceCriteria: ["One criterion", "Another criterion"],
        codeTests: [{ path: "test/a.test.ts", name: `a > REQ-${i} works`, linkedAt: "2026-11-01T00:00:00.000Z", linkedBy: "sam" }],
        tickets: [{ tracker: "linear", key: `CLN-${i}`, linkedAt: "2026-11-01T00:00:00.000Z", linkedBy: "sam" }],
      }),
    );
    const r = build({ ...emptyCollections(), requirements: many });
    expect(JSON.stringify(r).length).toBeLessThan(600_000);
  });
});

describe("record files", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), "gw-signoff-"));
    dirs.push(root);
    writeConfig(root, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [{ id: "sam", name: "Sam", role: "owner" }] });
    writeProduct(root, product());
    return root;
  };
  const record = (over: Partial<SignOffRecord> = {}): SignOffRecord => ({ ...build(state(), product(), "1.0"), ...over });

  it("record paths count sign-offs", () => {
    const root = project();
    expect(recordPath(root, "PRD-0001", "1.0")).toBe("groundwork/releases/PRD-0001-1-0-1.json");
    writeRecord(root, recordPath(root, "PRD-0001", "1.0"), record());
    expect(recordPath(root, "PRD-0001", "1.0")).toBe("groundwork/releases/PRD-0001-1-0-2.json");
  });

  it("writeRecord never overwrites", () => {
    const root = project();
    writeRecord(root, "groundwork/releases/PRD-0001-1-0-1.json", record());
    expect(() => writeRecord(root, "groundwork/releases/PRD-0001-1-0-1.json", record())).toThrow("groundwork/releases/PRD-0001-1-0-1.json already exists.");
  });

  it("withdrawRecord records who, when and why, once", () => {
    const root = project();
    const rel = "groundwork/releases/PRD-0001-1-0-1.json";
    writeRecord(root, rel, record());
    withdrawRecord(root, rel, "sam", "Shipped REQ-0009 too", "2026-11-29T00:00:00.000Z");
    expect(JSON.parse(readFileSync(join(root, rel), "utf8"))).toMatchObject({ withdrawnAt: "2026-11-29T00:00:00.000Z", withdrawnBy: "sam", withdrawReason: "Shipped REQ-0009 too" });
    expect(() => withdrawRecord(root, rel, "sam", "again", "x")).toThrow("already withdrawn");
  });

  it("activeRecord skips withdrawn records", () => {
    const root = project();
    writeRecord(root, "groundwork/releases/PRD-0001-1-0-1.json", record());
    withdrawRecord(root, "groundwork/releases/PRD-0001-1-0-1.json", "sam", "fix", "x");
    writeRecord(root, "groundwork/releases/PRD-0001-1-0-2.json", record());
    const { records } = loadRecords(root);
    expect(activeRecord(records, "PRD-0001", "1.0")?.file).toBe("groundwork/releases/PRD-0001-1-0-2.json");
    expect(activeRecord(records, "PRD-0001", "1.1")).toBeUndefined();
  });

  const problems = (root: string) => validate(load(root), readConfig(root), { root }).map((p) => `${p.level} ${p.file}: ${p.message}`);

  it("validate reports a record for a version that isn't released", () => {
    const root = project();
    writeRecord(root, "groundwork/releases/PRD-0001-1-1-1.json", { ...record(), version: "1.1" });
    expect(problems(root)).toContain("error groundwork/releases/PRD-0001-1-1-1.json: Acme app 1.1 isn't released");
  });

  it("validate reports two active records for a version", () => {
    const root = project();
    writeRecord(root, "groundwork/releases/PRD-0001-1-0-1.json", record());
    writeRecord(root, "groundwork/releases/PRD-0001-1-0-2.json", record());
    expect(problems(root)).toContain("error groundwork/releases/PRD-0001-1-0-2.json: Acme app 1.0 has more than one active sign-off: withdraw all but one");
  });

  it("validate reports a record whose file name doesn't match", () => {
    const root = project();
    writeRecord(root, "groundwork/releases/PRD-0001-9-9-1.json", record());
    expect(problems(root)).toContain("error groundwork/releases/PRD-0001-9-9-1.json: the file name should start with PRD-0001-1-0-");
  });

  it("validate reports a signOff record that's missing", () => {
    const root = project();
    writeProduct(root, product([{ version: "1.0", status: "released", releasedAt: "x", releasedBy: "sam", signOff: "groundwork/releases/PRD-0001-1-0-1.json" }, { version: "1.1", status: "planned" }]), load(root).paths.get("PRD-0001"));
    expect(problems(root).some((p) => p.includes("signOff groundwork/releases/PRD-0001-1-0-1.json doesn't exist"))).toBe(true);
  });

  it("an unreadable record is an error", () => {
    const root = project();
    mkdirSync(join(root, "groundwork/releases"), { recursive: true });
    writeFileSync(join(root, "groundwork/releases/PRD-0001-1-0-1.json"), "{");
    expect(problems(root).some((p) => p.startsWith("error groundwork/releases/PRD-0001-1-0-1.json: isn't a valid sign-off record"))).toBe(true);
    void readdirSync;
  });
});
