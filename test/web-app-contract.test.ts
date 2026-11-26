import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseReadiness } from "../src/core/readiness";
import { catalogueOf } from "../src/store/catalogue";
import { matrixOf, readConfig } from "../src/store/config";
import { load, renderItem, save } from "../src/store/files";
import { buildBundle } from "../src/store/import";
import { writeProduct } from "../src/store/products";
import { releaseVersion } from "../src/store/release";
import { loadResults, resultsFor } from "../src/store/results";
import { buildRecord, recordPath, versionScope, writeRecord } from "../src/store/signoff";

/**
 * The contract with the Groundwork web app's import. From a copy of examples/acme with one version signed off (1.1),
 * one released before sign-off records (1.0) and one planned (1.2), this builds the bundle `groundwork import` sends
 * and the blockers the local tools give each version. The web app's test (test/import-contract.test.ts there) imports
 * the bundle and must judge every version the same way.
 *
 * Regenerate with UPDATE_CONTRACT=1, then copy test/fixtures/web-app-contract.json to the web app's test/fixtures/ and
 * update CONTRACT_SHA256 in both repos' tests.
 */
export const CONTRACT_SHA256 = "7b7e075e5fe9d407f6a37c97dce1a62b47a967033fc34eb6aed99e3f1270a72a";

const FIXTURE = join(__dirname, "fixtures/web-app-contract.json");
const NOW = "2026-11-28T10:00:00.000Z";

function prepare(): string {
  const root = mkdtempSync(join(tmpdir(), "gw-contract-"));
  cpSync(join(__dirname, "../examples/acme/groundwork"), join(root, "groundwork"), { recursive: true });
  const write = (rel: string, data: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
  };
  let loaded = load(root);
  const product = loaded.products[0];
  // 1.2: a planned version after 1.1.
  writeProduct(root, { ...product, versions: [...product.versions, { version: "1.2", status: "planned" }] }, loaded.paths.get(product.id));
  loaded = load(root);
  // REQ-0003 (with its code test and TestRail case) is approved for 1.1.
  save(root, loaded, {
    ...loaded.items,
    requirements: loaded.items.requirements.map((r) =>
      r.id === "REQ-0003" ? { ...r, status: "approved", approvedBy: "sam", approvedAt: "2026-11-26T10:00:00.000Z", approver: "sam", plannedFor: "1.1" } : r.id === "REQ-0004" ? { ...r, status: "approved", approvedBy: "sam", approvedAt: "2026-11-26T10:00:00.000Z" } : r,
    ),
  });
  // 1.2: a requirement with a code test (passes in CI) and a Qase case (fails), and a high risk without mitigation.
  write(
    "groundwork/requirements/REQ-0005-show-import-history.md",
    renderItem({
      id: "REQ-0005",
      title: "Show import history",
      kind: "solution",
      story: "The system shall list every import with who ran it and when.",
      acceptanceCriteria: ["Each import is listed"],
      priority: "should",
      status: "approved",
      approvedBy: "sam",
      approvedAt: "2026-11-26T10:00:00.000Z",
      approver: "sam",
      stakeholderIds: ["REQ-0004"],
      product: "PRD-0001",
      plannedFor: "1.2",
      findingIds: [],
      codeTests: [{ path: "test/import-audit.test.ts", name: "import history > REQ-0005 lists imports", linkedAt: NOW, linkedBy: "sam" }],
      testCases: [{ tool: "qase", project: "ACME", id: "7", title: "History lists imports", linkedAt: NOW, linkedBy: "sam" }],
      createdAt: "2026-11-26T10:00:00.000Z",
    }),
  );
  write(
    "groundwork/risks/RSK-0002-history-shows-other-tenants.md",
    renderItem({ id: "RSK-0002", title: "History shows other tenants' imports", hazard: "The list isn't filtered by tenant.", harm: "One customer sees another's data.", probability: 4, severity: 5, mitigationIds: [], product: "PRD-0001", versions: ["1.2"], category: "security", owner: "sam", createdAt: "2026-11-26T10:00:00.000Z" }),
  );
  // Results: one CI run on main with both code tests passing; TestRail C101 passed for 1.1, Qase ACME-7 failed for 1.2.
  write("groundwork/results/ci/20261127T100000Z-abc1234-4521-1-test-aaaaaa.json", {
    id: "00000000-0000-4000-8000-00000000c101",
    commitSha: "abc1234def5678",
    ref: "refs/heads/main",
    at: "2026-11-27T10:00:00.000Z",
    source: "ci",
    defaultBranch: true,
    totals: { passed: 2, failed: 0, skipped: 0 },
    results: [
      { path: "test/import-audit.test.ts", name: "import audit > REQ-0003 records who, when and which file", status: "passed" },
      { path: "test/import-audit.test.ts", name: "import history > REQ-0005 lists imports", status: "passed" },
    ],
  });
  const toolRun = (tool: string, project: string, id: string, version: string, caseId: string, status: string) => ({
    source: "test-tool",
    tool,
    project,
    id,
    title: `${version} regression`,
    product: "PRD-0001",
    version,
    results: [{ id: caseId, status, endTime: "2026-11-27T11:00:00.000Z" }],
    recordedAt: "2026-11-27T12:00:00.000Z",
    recordedBy: "sam",
  });
  write("groundwork/results/tools/testrail-_-r11-00000001.json", toolRun("testrail", "", "R11", "1.1", "C101", "passed"));
  write("groundwork/results/tools/qase-acme-12-00000002.json", toolRun("qase", "ACME", "12", "1.2", "7", "failed"));

  // Release 1.1 and sign it off, as release_version would, at a fixed time.
  loaded = load(root);
  const config = readConfig(root);
  let catalogue = catalogueOf(config, loaded.products);
  const out = releaseVersion(loaded.items.requirements, catalogue, { product: loaded.products[0], version: "1.1", shipped: ["REQ-0003"], moveTo: "1.2", actor: "sam", now: NOW });
  save(root, loaded, { ...loaded.items, requirements: out.requirements });
  loaded = load(root);
  catalogue = catalogueOf(config, [out.product]);
  const record = buildRecord({
    state: loaded.items,
    catalogue,
    config,
    product: out.product,
    version: "1.1",
    tests: resultsFor(loadResults(root, config), out.product.id, "1.1"),
    fetch: { fetched: false, commit: null },
    actor: "sam",
    now: NOW,
    justification: "Accepted for the pilot.",
  });
  const rel = recordPath(root, out.product.id, "1.1");
  writeRecord(root, rel, record);
  writeProduct(root, { ...out.product, versions: out.product.versions.map((v) => (v.version === "1.1" ? { ...v, signOff: rel } : v)) }, loaded.paths.get(out.product.id));
  return root;
}

/** The local judgement of every version, from its scope as it is now: what the web app must also find. */
function expected(root: string) {
  const loaded = load(root);
  const config = readConfig(root);
  const catalogue = catalogueOf(config, loaded.products);
  const results = loadResults(root, config);
  const out: Record<string, { status: string; blockers: { type: string; key: string }[] }> = {};
  for (const p of loaded.products) {
    for (const v of p.versions) {
      const scope = versionScope(loaded.items, catalogue, p, v.version);
      const { blockers } = releaseReadiness(matrixOf(config), scope, loaded.items.requirements, resultsFor(results, p.id, v.version));
      out[v.version] = { status: v.status === "released" ? (v.signOff ? "signed-off" : "legacy") : "planned", blockers: blockers.map((b) => ({ type: b.type, key: b.refId })) };
    }
  }
  return out;
}

describe("the contract with the web app's import", () => {
  it("the committed contract fixture is current", () => {
    const root = prepare();
    try {
      const text = `${JSON.stringify({ bundle: buildBundle(root), expected: expected(root) }, null, 2)}\n`;
      if (process.env.UPDATE_CONTRACT) writeFileSync(FIXTURE, text);
      expect(existsSync(FIXTURE)).toBe(true);
      expect(readFileSync(FIXTURE, "utf8")).toBe(text);
      expect(createHash("sha256").update(text).digest("hex")).toBe(CONTRACT_SHA256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
