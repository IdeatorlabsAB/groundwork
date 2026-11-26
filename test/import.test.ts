import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // The web app can't take risks until its import is extended (PR 7), so these tests run on acme without them.
  rmSync(join(root, "groundwork", "risks"), { recursive: true, force: true });
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
    expect(b).toMatchObject({ format: "groundwork-files", schemaVersion: 1, dryRun: true, overwrite: false, config: { name: "Acme", products: ["Acme app"] } });
    expect(Object.fromEntries(Object.entries(b.items).map(([k, v]) => [k, v.length]))).toEqual({ insights: 3, hypotheses: 2, experiments: 1, findings: 1, requirements: 4 });
    expect(b.items.insights[0]).toMatchObject({ id: "INS-0001", notes: expect.stringContaining("Interview context") });
  });

  it("refuses a folder with risks rather than dropping them", () => {
    mkdirSync(join(root, "groundwork", "risks"));
    writeFileSync(
      join(root, "groundwork", "risks", "RSK-0001-wrong-user.md"),
      "---\nid: RSK-0001\ntitle: Wrong user\nhazard: x\nharm: y\nprobability: 2\nseverity: 2\nmitigationIds: []\nversions: []\n---\n",
    );
    expect(() => buildBundle(root, { dryRun: true })).toThrow(ImportError);
    expect(() => buildBundle(root, { dryRun: true })).toThrow(/risks/);
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
