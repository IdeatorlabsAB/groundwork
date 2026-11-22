import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogueOf, findArea, findProduct } from "../src/store/catalogue";
import { readConfig, writeConfig } from "../src/store/config";
import { load } from "../src/store/files";
import { nextProductId, writeProduct } from "../src/store/products";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gw-catalogue-"));
  writeConfig(root, { schemaVersion: 2, name: "Clinicare", productAreas: [], products: [], people: [] });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("product files and the catalogue", () => {
  it("loads product files into the catalogue", () => {
    writeProduct(root, {
      id: "PRD-0001",
      title: "Clinicare Web Application",
      areas: [{ id: "scheduling", label: "Scheduling" }],
      versions: [{ version: "1.0", status: "planned" }],
    });
    const c = catalogueOf(readConfig(root), load(root).products);
    expect(c.legacy).toBe(false);
    expect(c.areas).toEqual([{ id: "scheduling", label: "Scheduling", productId: "PRD-0001" }]);
    expect(findProduct(c, "clinicare web application")?.id).toBe("PRD-0001");
    expect(findArea(c, "SCHEDULING")?.productId).toBe("PRD-0001");
  });

  it("treats flat config lists without product files as a legacy catalogue", () => {
    writeConfig(root, { ...readConfig(root), productAreas: [{ id: "onboarding", label: "Onboarding" }], products: ["Acme app"] });
    const c = catalogueOf(readConfig(root), load(root).products);
    expect(c).toMatchObject({ legacy: true, productNames: ["Acme app"], areas: [{ id: "onboarding", label: "Onboarding" }] });
  });

  it("keeps notes and comments when a product file is rewritten", () => {
    const path = writeProduct(root, { id: "PRD-0001", title: "Clinicare", areas: [], versions: [] });
    writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replace("---\n", "---\n# ours\n") + "\nRoadmap notes.\n");
    writeProduct(root, { ...load(root).products[0], versions: [{ version: "1.0", status: "planned" }] }, path);
    const text = readFileSync(join(root, path), "utf8");
    expect(text).toContain("# ours");
    expect(text).toContain("Roadmap notes.");
    expect(load(root).products[0].versions).toEqual([{ version: "1.0", status: "planned" }]);
  });

  it("reads schemaVersion 1 and 2, and refuses 3", () => {
    writeConfig(root, { ...readConfig(root), schemaVersion: 2 });
    expect(readConfig(root).schemaVersion).toBe(2);
    writeConfig(root, { ...readConfig(root), schemaVersion: 3 });
    expect(() => readConfig(root)).toThrow(/understands up to 2/);
  });

  it("numbers new products after the highest", () => {
    expect(nextProductId([{ id: "PRD-0002", title: "x", areas: [], versions: [] }])).toBe("PRD-0003");
  });
});
