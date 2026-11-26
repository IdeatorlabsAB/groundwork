import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renumber } from "../src/store/branches";
import { readConfig, writeConfig } from "../src/store/config";
import { assignIds, load, renderItem, save } from "../src/store/files";
import { writeProduct } from "../src/store/products";
import { validate } from "../src/store/validate";

let root: string;
const RISKS = "groundwork/risks";
const REQS = "groundwork/requirements";

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const risk = (id: string, extra: Record<string, unknown> = {}) =>
  renderItem({ id, title: "Import attributed to the wrong user", hazard: "h", harm: "x", probability: 2, severity: 2, mitigationIds: [], versions: [], product: "PRD-0001", createdAt: "2026-11-01T00:00:00.000Z", ...extra });

const stakeholder = renderItem({
  id: "REQ-0001",
  title: "Prove who imported what",
  kind: "stakeholder",
  story: "As an auditor I want to see who imported each file so that I can trace changes.",
  acceptanceCriteria: ["Shown"],
  status: "approved",
  findingIds: [],
  createdAt: "2026-11-01T00:00:00.000Z",
});
const solution = (extra: Record<string, unknown> = {}) =>
  renderItem({
    id: "REQ-0002",
    title: "Record the importing user",
    kind: "solution",
    story: "The importer shall record the signed-in user on each import.",
    acceptanceCriteria: ["Recorded"],
    status: "approved",
    stakeholderIds: ["REQ-0001"],
    product: "PRD-0001",
    plannedFor: "1.1",
    findingIds: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  });

function setup(config: Record<string, unknown> = {}) {
  writeConfig(root, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [{ id: "sam", name: "Sam", role: "owner" }], ...config } as never);
  writeProduct(root, {
    id: "PRD-0001",
    title: "Acme app",
    areas: [],
    versions: [
      { version: "1.0", status: "released", releasedAt: "2026-10-01T00:00:00.000Z", releasedBy: "sam" },
      { version: "1.1", status: "planned" },
    ],
    createdAt: "2026-11-01T00:00:00.000Z",
  } as never);
  write(`${REQS}/REQ-0001-prove-who-imported-what.md`, stakeholder);
}

const problems = () => validate(load(root), readConfig(root), { root }).map((p) => `${p.level} ${p.file}: ${p.message}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "groundwork-risks-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("risk files", () => {
  it("a risk file round-trips through load and save, keeping the Markdown body", () => {
    setup();
    write(`${RISKS}/RSK-0001-wrong-user.md`, risk("RSK-0001", { notes: "Seen in the 2025 audit." }));
    const loaded = load(root);
    expect(loaded.problems).toEqual([]);
    expect(loaded.items.risks[0]).toMatchObject({ id: "RSK-0001", probability: 2, notes: "Seen in the 2025 audit." });
    save(root, loaded, { ...loaded.items, risks: [{ ...loaded.items.risks[0], residualProbability: 1 }] });
    const text = readFileSync(join(root, RISKS, "RSK-0001-wrong-user.md"), "utf8");
    expect(text).toContain("residualProbability: 1");
    expect(text).toContain("Seen in the 2025 audit.");
  });

  it("new risks get RSK-0001, RSK-0002 in creation order and links are rewritten", () => {
    setup();
    const before = load(root).items;
    const req = { ...before.requirements[0], id: "new-req", riskIds: ["new-r1"] };
    const r1 = { id: "new-r1", title: "A", hazard: "", harm: "", probability: 1, severity: 1, mitigationIds: ["new-req"], versions: [], createdAt: "x" };
    const r2 = { ...r1, id: "new-r2", title: "B", mitigationIds: [] };
    const { items } = assignIds(before, { ...before, requirements: [req, ...before.requirements], risks: [r1, r2] });
    expect(items.risks.map((r) => r.id)).toEqual(["RSK-0001", "RSK-0002"]);
    expect(items.risks[0].mitigationIds).toEqual(["REQ-0002"]);
    expect(items.requirements[0].riskIds).toEqual(["RSK-0001"]);
  });

  it("a file in risks/ with an REQ- id is a load problem", () => {
    setup();
    write(`${RISKS}/REQ-0009-oops.md`, risk("REQ-0009"));
    expect(load(root).problems.map((p) => p.message)).toEqual(["REQ-0009 is in risks/, but risks ids start with RSK-"]);
  });
});

describe("validate risks", () => {
  it("reports a score outside the matrix", () => {
    setup();
    write(`${RISKS}/RSK-0001-a.md`, risk("RSK-0001", { probability: 6, residualSeverity: 0 }));
    expect(problems()).toEqual(
      expect.arrayContaining([
        `error ${RISKS}/RSK-0001-a.md: probability 6 is outside the 5×5 risk matrix (1–5)`,
        `error ${RISKS}/RSK-0001-a.md: residualSeverity 0 is outside the 5×5 risk matrix (1–5)`,
      ]),
    );
  });

  it("validate reports scores outside a shrunk matrix", () => {
    setup({
      riskMatrix: {
        size: 3,
        probabilityLabels: ["Low", "Medium", "High"],
        severityLabels: ["Low", "Medium", "High"],
        cells: [
          ["low", "low", "medium"],
          ["low", "medium", "high"],
          ["medium", "high", "high"],
        ],
      },
    });
    write(`${RISKS}/RSK-0001-a.md`, risk("RSK-0001", { probability: 4 }));
    expect(problems()).toContain(`error ${RISKS}/RSK-0001-a.md: probability 4 is outside the 3×3 risk matrix (1–3)`);
  });

  it("reports mitigations that don't exist or aren't requirements", () => {
    setup();
    write("groundwork/insights/INS-0001-a.md", renderItem({ id: "INS-0001", title: "A", quote: "q", source: "interview", persona: "P", tags: [], sentiment: "neutral", createdAt: "x" }));
    write(`${RISKS}/RSK-0001-a.md`, risk("RSK-0001", { mitigationIds: ["REQ-0009", "INS-0001"] }));
    expect(problems()).toEqual(
      expect.arrayContaining([`error ${RISKS}/RSK-0001-a.md: mitigationIds: REQ-0009 doesn't exist`, `error ${RISKS}/RSK-0001-a.md: mitigationIds: INS-0001 is a insight, not a requirement`]),
    );
  });

  it("reports an unknown product", () => {
    setup();
    write(`${RISKS}/RSK-0001-a.md`, risk("RSK-0001", { product: "PRD-0009" }));
    expect(problems()).toContain(`error ${RISKS}/RSK-0001-a.md: product "PRD-0009" doesn't exist`);
  });

  it("reports a version its product doesn't have", () => {
    setup();
    write(`${RISKS}/RSK-0001-a.md`, risk("RSK-0001", { versions: ["1.1", "2.0"] }));
    expect(problems()).toContain(`error ${RISKS}/RSK-0001-a.md: versions: "2.0" isn't a version of PRD-0001`);
  });

  it("reports a requirement whose riskIds the risk doesn't list back", () => {
    setup();
    write(`${RISKS}/RSK-0001-a.md`, risk("RSK-0001"));
    write(`${REQS}/REQ-0002-record.md`, solution({ riskIds: ["RSK-0001"] }));
    expect(problems()).toContain(`error ${REQS}/REQ-0002-record.md: riskIds: RSK-0001 doesn't list REQ-0002 as a mitigation`);
  });

  it("accepts mitigations listed on both sides", () => {
    setup();
    write(`${RISKS}/RSK-0001-a.md`, risk("RSK-0001", { mitigationIds: ["REQ-0002"] }));
    write(`${REQS}/REQ-0002-record.md`, solution({ riskIds: ["RSK-0001"] }));
    expect(problems().filter((p) => p.includes("RSK-0001") || p.includes("REQ-0002"))).toEqual([]);
  });

  it("warns about a high risk without a mitigating requirement", () => {
    setup();
    write(`${RISKS}/RSK-0001-a.md`, risk("RSK-0001", { probability: 5, severity: 5 }));
    expect(problems()).toContain(`warning ${RISKS}/RSK-0001-a.md: high risk "Import attributed to the wrong user" has no mitigating requirement`);
  });

  it("warns about codeRefs that don't exist", () => {
    setup();
    write(`${RISKS}/RSK-0001-a.md`, risk("RSK-0001", { codeRefs: ["src/import.ts#run"] }));
    expect(problems()).toContain(`warning ${RISKS}/RSK-0001-a.md: codeRefs: src/import.ts doesn't exist`);
  });
});

describe("renumbering risks", () => {
  it("renumber rewrites mitigationIds and riskIds", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    setup();
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("branch", "feature");
    write(`${RISKS}/RSK-0001-from-main.md`, risk("RSK-0001", { title: "From main" }));
    git("add", "-A");
    git("commit", "-q", "-m", "main adds RSK-0001");
    git("checkout", "-q", "feature");
    write(`${RISKS}/RSK-0001-from-feature.md`, risk("RSK-0001", { title: "From feature", mitigationIds: ["REQ-0002"] }));
    write(`${REQS}/REQ-0002-record.md`, solution({ riskIds: ["RSK-0001"] }));
    git("add", "-A");
    git("commit", "-q", "-m", "feature adds RSK-0001");

    const out = renumber(root, "main");
    expect(out.renumbered.map((r) => [r.from, r.to])).toEqual([["RSK-0001", "RSK-0002"]]);
    expect(readFileSync(join(root, REQS, "REQ-0002-record.md"), "utf8")).toContain("- RSK-0002");
    expect(load(root).items.risks.find((r) => r.title === "From feature")?.id).toBe("RSK-0002");
  });
});
