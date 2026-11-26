import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/store/config";
import { buildBundle, ImportError, runImport } from "../src/store/import";

let root: string;
const TOKEN = "gw_" + "a".repeat(43);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "groundwork-import-"));
  cpSync(join(__dirname, "../examples/acme/groundwork"), join(root, "groundwork"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeServer(status = 200, reply: Record<string, unknown> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ workspace: "Acme", url: "https://gw.example/app", dryRun: body.dryRun, created: 11, updated: 0, skipped: 0, addedAreas: [], addedProducts: [], warnings: [], ids: {}, ...reply }),
      { status },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("groundwork import", () => {
  it("sends product names, not product ids, so the web app's product list stays clean", () => {
    const b = buildBundle(root, { dryRun: true });
    const products = b.items.requirements.map((r) => r.product).filter(Boolean);
    expect(products.length).toBeGreaterThan(0);
    expect(new Set(products)).toEqual(new Set(["Acme app"]));
  });

  it("bundles every item, the config and the options", () => {
    const b = buildBundle(root, { dryRun: true });
    expect(b).toMatchObject({ format: "groundwork-files", schemaVersion: 2, dryRun: true, overwrite: false, config: { name: "Acme", products: ["Acme app"] } });
    expect(Object.fromEntries(Object.entries(b.items).map(([k, v]) => [k, v.length]))).toEqual({ insights: 3, hypotheses: 2, experiments: 1, findings: 1, requirements: 4, risks: 1 });
    expect(b.items.insights[0]).toMatchObject({ id: "INS-0001", notes: expect.stringContaining("Interview context") });
  });

  it("bundles risks, versions, records, CI runs and test-tool runs", () => {
    mkdirSync(join(root, "groundwork", "results", "ci"), { recursive: true });
    mkdirSync(join(root, "groundwork", "results", "tools"), { recursive: true });
    mkdirSync(join(root, "groundwork", "releases"), { recursive: true });
    const run = (id: string, source: string) => ({ id, commitSha: "abc1234def", ref: "refs/heads/main", at: "2026-11-27T10:00:00.000Z", source, defaultBranch: true, totals: { passed: 1, failed: 0, skipped: 0 }, results: [] });
    writeFileSync(join(root, "groundwork/results/ci/20261127T100000Z-abc1234-ci.json"), JSON.stringify(run("ci-run", "ci")));
    writeFileSync(join(root, "groundwork/results/ci/20261127T110000Z-abc1234-local.json"), JSON.stringify(run("local-run", "local")));
    writeFileSync(
      join(root, "groundwork/results/tools/testrail-_-r3-00000000.json"),
      JSON.stringify({ source: "test-tool", tool: "testrail", project: "", id: "R3", title: "Smoke", product: "PRD-0001", version: "1.1", results: [], recordedAt: "x", recordedBy: "sam" }),
    );
    writeFileSync(join(root, "groundwork/releases/PRD-0001-1-0-1.json"), JSON.stringify({ schemaVersion: 1, kind: "release", product: { id: "PRD-0001", title: "Acme app" }, version: "1.0", signedAt: "x", signedOffBy: { id: "sam", name: "Sam" }, people: {}, matrix: {}, risks: [], requirements: [], blockers: [], report: {} }));
    const b = buildBundle(root, { dryRun: true });
    expect(b.schemaVersion).toBe(2);
    expect(b.items.risks.map((r) => [r.id, r.product])).toEqual([["RSK-0001", "Acme app"]]);
    expect(b.versions).toEqual([
      expect.objectContaining({ productId: "PRD-0001", product: "Acme app", version: "1.0", status: "released" }),
      expect.objectContaining({ productId: "PRD-0001", product: "Acme app", version: "1.1", status: "planned" }),
    ]);
    expect(b.records.map((r) => r.file)).toEqual(["groundwork/releases/PRD-0001-1-0-1.json"]);
    expect(b.testRuns.map((r) => [r.id, r.product, r.productId])).toEqual([["R3", "Acme app", "PRD-0001"]]);
    // Runs from outside CI never count as evidence, so they aren't sent.
    expect(b.codeRuns.map((r) => r.id)).toEqual(["ci-run"]);
  });

  it("sends a requirement without a product as the only product's", () => {
    const b = buildBundle(root, { dryRun: true });
    expect(b.items.requirements.filter((r) => r.kind === "solution").every((r) => r.product === "Acme app")).toBe(true);
  });

  it("explains a web app that doesn't take this format yet", async () => {
    const fetch = (async () => Response.json({ error: { message: "This isn't a groundwork import: schemaVersion: Invalid input: expected 1" } }, { status: 400 })) as unknown as typeof globalThis.fetch;
    await expect(runImport({ root, to: "https://gw.example", token: TOKEN, fetch })).rejects.toThrow("Update the Groundwork web app first: it doesn't take this folder's format yet.");
  });

  it("posts to /api/import with the token and marks the folder migrated", async () => {
    const server = fakeServer();
    const r = await runImport({ root, to: "https://gw.example/some/page", token: TOKEN, fetch: server.fetch });
    expect(r.created).toBe(11);
    expect(server.calls[0].url).toBe("https://gw.example/api/import");
    expect((server.calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(readConfig(root).migrated).toBe("https://gw.example/app");
    expect(readFileSync(join(root, "groundwork/config.yml"), "utf8")).toContain("migrated: https://gw.example/app");
  });

  it("leaves the folder alone on a dry run or an error", async () => {
    await runImport({ root, to: "https://gw.example", token: TOKEN, dryRun: true, fetch: fakeServer().fetch });
    expect(readConfig(root).migrated).toBeUndefined();
    await expect(runImport({ root, to: "https://gw.example", token: TOKEN, fetch: fakeServer(401, { error: { message: "Unknown token" } }).fetch })).rejects.toThrow(
      "Unknown token",
    );
    expect(readConfig(root).migrated).toBeUndefined();
  });

  it("refuses plain http, bad tokens and projects with errors", async () => {
    await expect(runImport({ root, to: "http://gw.example", token: TOKEN, fetch: fakeServer().fetch })).rejects.toThrow("https address");
    await expect(runImport({ root, to: "https://gw.example", token: "nope", fetch: fakeServer().fetch })).rejects.toThrow("agent token");
    rmSync(join(root, "groundwork/hypotheses"), { recursive: true });
    await expect(runImport({ root, to: "https://gw.example", token: TOKEN, fetch: fakeServer().fetch })).rejects.toBeInstanceOf(ImportError);
  });
});
